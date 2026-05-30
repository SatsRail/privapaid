import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { prisma } from "@/lib/prisma";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { dekBase64urlFromEnvelope } from "@/lib/media-envelope";

/**
 * POST /api/admin/products/[id]/re-encrypt
 *
 * Re-encrypts every MediaProduct attached to this product after a key rotation.
 * The plaintext is the media DEK, recovered locally from each media's
 * MediaEnvelope.wrappedDek (CONTENT_KEK) — not by decrypting the old ciphertext
 * with SatsRail's old_key. That pre-rotation key has proven unreliable: the
 * portal can clear it independently, and any temporary fetch failure used to
 * mean unrecoverable rotation. The envelope bytes never change here.
 *
 * Streams progress back to the client as newline-delimited JSON.
 *
 * Flow:
 *   1. Fetch new key from SatsRail (only one round-trip).
 *   2. Find the local Product row, load all its MediaProduct entries.
 *   3. For each entry: look up the Media's envelope, recover the DEK, re-wrap.
 *   4. On clean run: clear old_key via SatsRail.
 *
 * Failure modes (still surfaced as `errors`):
 *   - Media (or its envelope) not found.
 *   - CONTENT_KEK not configured.
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
    include: { mediaProducts: true },
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

  const blobs = productRow.mediaProducts;
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
    select: { id: true, envelope: { select: { wrappedDek: true } } },
  });
  const mediaById = new Map<string, (typeof mediaDocs)[number]>();
  for (const m of mediaDocs) mediaById.set(m.id, m);

  // The product-key plaintext is the media DEK, recovered from the envelope's
  // CONTENT_KEK-wrapped copy. Uniform across all media kinds.
  function plaintextForMedia(mediaId: string): string {
    const media = mediaById.get(mediaId);
    if (!media) {
      throw new Error(`Media ${mediaId} not found — was it deleted?`);
    }
    if (!media.envelope) {
      throw new Error(`Media ${mediaId} has no envelope`);
    }
    return dekBase64urlFromEnvelope(media.envelope);
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
          await prisma.mediaProduct.update({
            where: { id: entry.id },
            data: { encryptedDek: encrypted },
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
        // Re-encryption rewrote every blob for this product, so any media we
        // previously flagged `error` over an undecryptable blob is now fixed.
        // Lift the flag automatically — the admin shouldn't have to clear it
        // by hand after a clean rotation. Non-critical: a failure here must
        // not fail the rotation, so we don't increment `errors`.
        try {
          await prisma.media.updateMany({
            where: { id: { in: mediaIds }, status: "error" },
            data: { status: "ok", statusReason: null, statusChangedAt: new Date() },
          });
        } catch (err) {
          console.error("Failed to clear media error status after re-encrypt:", err);
        }
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
