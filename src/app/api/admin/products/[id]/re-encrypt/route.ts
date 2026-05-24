import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { connectDB } from "@/lib/mongodb";
import Media from "@/models/Media";
import MediaProduct from "@/models/MediaProduct";
import ChannelProduct from "@/models/ChannelProduct";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { unwrapDekToBase64url } from "@/lib/photo-dek";

/**
 * POST /api/admin/products/[id]/re-encrypt
 *
 * Re-encrypts every MediaProduct and ChannelProduct entry that wraps this
 * product's key after a key rotation. Plaintext is sourced from the local
 * DB (Media.source_url for non-photo; Media.encrypted_dek unwrapped via
 * PHOTO_KEK for photos), not by decrypting the old ciphertext with
 * SatsRail's old_key. That pre-rotation key has proven unreliable in
 * practice: the portal can clear it independently, and any temporary
 * fetch failure used to mean unrecoverable rotation.
 *
 * Streams progress back to the client as newline-delimited JSON.
 *
 * Flow:
 *   1. Fetch new key from SatsRail (only one round-trip).
 *   2. For each MediaProduct: lookup Media, derive plaintext, re-encrypt.
 *   3. For each ChannelProduct entry: same.
 *   4. On clean run: clear old_key via SatsRail.
 *
 * Failure modes (still surfaced as `errors`):
 *   - Media not found (was deleted before rotation completed).
 *   - Photo media missing `encrypted_dek` (legacy upload, no KEK copy).
 *   - PHOTO_KEK not configured and we have photos to rotate.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireOwnerApi();
  if (authResult instanceof NextResponse) return authResult;

  const { id: productId } = await params;

  const skLive = await getMerchantKey();
  if (!skLive) {
    return NextResponse.json(
      { error: "Merchant API key not configured" },
      { status: 422 }
    );
  }

  // We only need the new key — the old one is irrelevant when plaintext
  // is sourced locally.
  let newKey: string;
  try {
    const keyData = await satsrail.getProductKey(skLive, productId);
    newKey = keyData.key;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch product key";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  await connectDB();
  const mediaProducts = await MediaProduct.find({
    satsrail_product_id: productId,
  });
  const channelProducts = await ChannelProduct.find({
    satsrail_product_id: productId,
  });

  // Plan work items so the progress total is honest before we start.
  type WorkItem =
    | { kind: "media_product"; mp: typeof mediaProducts[number] }
    | {
        kind: "channel_entry";
        cp: typeof channelProducts[number];
        entryIndex: number;
      };

  const work: WorkItem[] = [];
  for (const mp of mediaProducts) work.push({ kind: "media_product", mp });
  for (const cp of channelProducts) {
    for (let i = 0; i < cp.encrypted_media.length; i++) {
      work.push({ kind: "channel_entry", cp, entryIndex: i });
    }
  }
  const total = work.length;

  if (total === 0) {
    try {
      await satsrail.clearOldKey(skLive, productId);
    } catch (err) {
      console.error("Failed to clear old_key:", err);
    }
    return NextResponse.json({ done: true, total: 0, errors: 0 });
  }

  // Pre-load every Media we might need in one query so the inner loop
  // doesn't N+1.
  const mediaIds = new Set<string>();
  for (const mp of mediaProducts) mediaIds.add(String(mp.media_id));
  for (const cp of channelProducts) {
    for (const entry of cp.encrypted_media) mediaIds.add(String(entry.media_id));
  }
  const mediaDocs = await Media.find({ _id: { $in: Array.from(mediaIds) } })
    .lean();
  const mediaById = new Map<string, (typeof mediaDocs)[number]>();
  for (const m of mediaDocs) mediaById.set(String(m._id), m);

  // Track which ChannelProducts we mutated so we save once at the end.
  const touchedChannelProducts = new Set<typeof channelProducts[number]>();

  function plaintextForMedia(mediaId: string): string {
    const media = mediaById.get(mediaId);
    if (!media) {
      throw new Error(`Media ${mediaId} not found — was it deleted?`);
    }
    if (media.media_type === "photo") {
      if (!media.encrypted_dek) {
        throw new Error(
          `Photo media ${mediaId} has no encrypted_dek — re-upload required`
        );
      }
      return unwrapDekToBase64url(media.encrypted_dek);
    }
    return media.source_url;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let errors = 0;
      let current = 0;

      for (const item of work) {
        current++;
        try {
          if (item.kind === "media_product") {
            const plaintext = plaintextForMedia(String(item.mp.media_id));
            item.mp.encrypted_source_url = encryptSourceUrl(
              plaintext,
              newKey,
              productId
            );
            await item.mp.save();
          } else {
            const entry = item.cp.encrypted_media[item.entryIndex];
            const plaintext = plaintextForMedia(String(entry.media_id));
            entry.encrypted_source_url = encryptSourceUrl(
              plaintext,
              newKey,
              productId
            );
            touchedChannelProducts.add(item.cp);
          }
        } catch (err) {
          errors++;
          console.error(
            `Failed to re-encrypt work item ${current}/${total}:`,
            err
          );
        }

        controller.enqueue(
          encoder.encode(JSON.stringify({ current, total, errors }) + "\n")
        );
      }

      // Save ChannelProduct mutations now that all entries are updated.
      for (const cp of touchedChannelProducts) {
        try {
          cp.markModified("encrypted_media");
          await cp.save();
        } catch (err) {
          errors++;
          console.error(`Failed to save channel product ${cp._id}:`, err);
        }
      }

      // Only clear old_key if everything succeeded — partial success means
      // the admin should retry, and the old_key is still useful as a
      // crosscheck during that retry.
      if (errors === 0) {
        try {
          await satsrail.clearOldKey(skLive, productId);
        } catch (err) {
          console.error("Failed to clear old_key:", err);
          errors++;
        }
      }

      controller.enqueue(
        encoder.encode(JSON.stringify({ done: true, total, errors }) + "\n")
      );
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    },
  });
}
