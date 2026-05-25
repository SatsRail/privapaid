import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { prisma } from "@/lib/prisma";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { unwrapDekToBase64url } from "@/lib/photo-dek";

/**
 * POST /api/admin/products/[id]/re-encrypt
 *
 * Re-encrypts every MediaProduct and ChannelProductMedia entry that wraps
 * this product's key after a key rotation. Plaintext is sourced from the
 * local DB (Media.sourceUrl for non-photo; Media.encryptedDek unwrapped via
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
 *   3. For each ChannelProductMedia entry: same.
 *   4. On clean run: clear old_key via SatsRail.
 *
 * Failure modes (still surfaced as `errors`):
 *   - Media not found (was deleted before rotation completed).
 *   - Photo media missing `encryptedDek` (legacy upload, no KEK copy).
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

  const mediaProducts = await prisma.mediaProduct.findMany({
    where: { satsrailProductId: productId },
  });
  const channelProducts = await prisma.channelProduct.findMany({
    where: { satsrailProductId: productId },
    include: { encryptedMedia: true },
  });

  // Plan work items so the progress total is honest before we start.
  type WorkItem =
    | { kind: "media_product"; mp: (typeof mediaProducts)[number] }
    | {
        kind: "channel_entry";
        entry: (typeof channelProducts)[number]["encryptedMedia"][number];
      };

  const work: WorkItem[] = [];
  for (const mp of mediaProducts) work.push({ kind: "media_product", mp });
  for (const cp of channelProducts) {
    for (const entry of cp.encryptedMedia) {
      work.push({ kind: "channel_entry", entry });
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

  // Pre-load every Media we might need in one query so the inner loop doesn't N+1.
  const mediaIds = new Set<string>();
  for (const mp of mediaProducts) mediaIds.add(mp.mediaId);
  for (const cp of channelProducts) {
    for (const entry of cp.encryptedMedia) mediaIds.add(entry.mediaId);
  }
  const mediaDocs = await prisma.media.findMany({
    where: { id: { in: Array.from(mediaIds) } },
  });
  const mediaById = new Map<string, (typeof mediaDocs)[number]>();
  for (const m of mediaDocs) mediaById.set(m.id, m);

  function plaintextForMedia(mediaId: string): string {
    const media = mediaById.get(mediaId);
    if (!media) {
      throw new Error(`Media ${mediaId} not found — was it deleted?`);
    }
    if (media.mediaType === "photo") {
      if (!media.encryptedDek) {
        throw new Error(
          `Photo media ${mediaId} has no encryptedDek — re-upload required`
        );
      }
      return unwrapDekToBase64url(media.encryptedDek);
    }
    return media.sourceUrl;
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
            const plaintext = plaintextForMedia(item.mp.mediaId);
            const encrypted = encryptSourceUrl(plaintext, newKey, productId);
            await prisma.mediaProduct.update({
              where: { id: item.mp.id },
              data: { encryptedSourceUrl: encrypted },
            });
          } else {
            const plaintext = plaintextForMedia(item.entry.mediaId);
            const encrypted = encryptSourceUrl(plaintext, newKey, productId);
            await prisma.channelProductMedia.update({
              where: { id: item.entry.id },
              data: { encryptedSourceUrl: encrypted },
            });
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
