import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Hard ceiling on the ciphertext we'll serve. Plaintext photos are capped at
 * 5 MB upstream; the GCM envelope adds ~28 bytes. 10 MB gives generous
 * headroom while keeping a corrupted row or future feature from buffering
 * a multi-GB blob into a single response.
 */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * GET /api/photos/[id]
 *
 * Serves the AES-256-GCM ciphertext for an encrypted photo from the
 * `EncryptedPhotoBlob` table. No auth required: the bytes are useless
 * without the DEK, which is itself encrypted under a SatsRail product key
 * and only delivered to the viewer after payment.
 *
 * Rate-limited to discourage scraping; clients only need this once per view.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const limited = await rateLimit("photo_fetch", 120);
  if (limited) return limited;

  const { id } = await params;

  if (!id || id.length === 0) {
    return NextResponse.json({ error: "Invalid photo ID" }, { status: 400 });
  }

  try {
    const blob = await prisma.encryptedPhotoBlob.findUnique({
      where: { id },
      select: { bytes: true, mimeType: true },
    });

    if (!blob) {
      return NextResponse.json({ error: "Photo not found" }, { status: 404 });
    }

    if (blob.bytes.length > MAX_PHOTO_BYTES) {
      return NextResponse.json(
        { error: "Photo exceeds size limit" },
        { status: 413 }
      );
    }

    return new Response(blob.bytes, {
      headers: {
        // Always opaque/octet-stream — the bytes are AES-GCM ciphertext.
        // The original plaintext MIME is recorded on the EncryptedPhotoBlob
        // row but only the client (after DEK decrypt) can surface it.
        "Content-Type": "application/octet-stream",
        "Content-Length": blob.bytes.length.toString(),
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: `"${id}"`,
      },
    });
  } catch (err) {
    console.error("photos.GET: failed to serve", err);
    return NextResponse.json({ error: "Failed to serve photo" }, { status: 500 });
  }
}
