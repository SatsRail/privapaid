import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { prisma } from "@/lib/prisma";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { unwrapDekToBase64url } from "@/lib/photo-dek";
import { parseMediaBlob, plaintextForEncryption } from "@/lib/schemas/media-blob";

/**
 * POST /api/admin/products/[id]/re-encrypt
 *
 * Re-encrypts every MediaEncryptedBlob attached to this product after a key
 * rotation. Plaintext is sourced from the local DB (Media.blob — URL,
 * markdown body, or PHOTO_KEK-wrapped DEK), not by decrypting the old
 * ciphertext with SatsRail's old_key. That pre-rotation key has proven
 * unreliable in practice: the portal can clear it independently, and any
 * temporary fetch failure used to mean unrecoverable rotation.
 *
 * Streams progress back to the client as newline-delimited JSON.
 *
 * Flow:
 *   1. Fetch new key from SatsRail (only one round-trip).
 *   2. Find the local Product row, load all its MediaEncryptedBlob entries.
 *   3. For each blob: lookup the Media, derive plaintext, re-encrypt.
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

  const { id: satsrailProductId } = await params;

  const skLive = await getMerchantKey();
  if (!skLive) {
    return NextResponse.json(
      { error: "Merchant API key not configured" },
      { status: 422 }
    );
  }

  // Only the new key matters when plaintext is sourced locally.
  let newKey: string;
  try {
    const keyData = await satsrail.getProductKey(skLive, satsrailProductId);
    newKey = keyData.key;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch product key";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const productRow = await prisma.product.findUnique({
    where: { satsrailProductId },
    include: { mediaEncryptedBlobs: true },
  });

  if (!productRow) {
    // No local product yet — clear old_key and return clean.
    try {
      await satsrail.clearOldKey(skLive, satsrailProductId);
    } catch (err) {
      console.error("Failed to clear old_key:", err);
    }
    return NextResponse.json({ done: true, total: 0, errors: 0 });
  }

  const blobs = productRow.mediaEncryptedBlobs;
  const total = blobs.length;

  if (total === 0) {
    try {
      await satsrail.clearOldKey(skLive, satsrailProductId);
    } catch (err) {
      console.error("Failed to clear old_key:", err);
    }
    return NextResponse.json({ done: true, total: 0, errors: 0 });
  }

  // Pre-load every Media in one query so the inner loop doesn't N+1.
  const mediaIds = Array.from(new Set(blobs.map((b) => b.mediaId)));
  const mediaDocs = await prisma.media.findMany({
    where: { id: { in: mediaIds } },
  });
  const mediaById = new Map<string, (typeof mediaDocs)[number]>();
  for (const m of mediaDocs) mediaById.set(m.id, m);

  function plaintextForMedia(mediaId: string): string {
    const media = mediaById.get(mediaId);
    if (!media) {
      throw new Error(`Media ${mediaId} not found — was it deleted?`);
    }
    const blob = parseMediaBlob(media.blob);
    if (blob.kind === "photo") {
      return unwrapDekToBase64url(blob.encryptedDek);
    }
    return plaintextForEncryption(blob);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let errors = 0;
      let current = 0;

      for (const entry of blobs) {
        current++;
        try {
          const plaintext = plaintextForMedia(entry.mediaId);
          const encrypted = encryptSourceUrl(plaintext, newKey, satsrailProductId);
          await prisma.mediaEncryptedBlob.update({
            where: { id: entry.id },
            data: { encryptedSourceUrl: encrypted },
          });
        } catch (err) {
          errors++;
          console.error(
            `Failed to re-encrypt blob ${current}/${total}:`,
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
          await satsrail.clearOldKey(skLive, satsrailProductId);
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
