import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Hard ceiling on the ciphertext we'll serve. Plaintext photos are capped at
 * 5 MB upstream and article markdown at 500 KB; the GCM envelope adds ~28
 * bytes. 10 MB gives generous headroom while keeping a corrupted row or
 * future feature from buffering a multi-GB blob into a single response.
 */
const MAX_ENVELOPE_BYTES = 10 * 1024 * 1024;

/**
 * GET /api/envelopes/[id]
 *
 * Serves the AES-256-GCM ciphertext for an envelope-encrypted content row
 * (photo bytes, article markdown) from the `EncryptedEnvelope` table. No
 * auth required: the bytes are useless without the DEK, which is itself
 * encrypted under a SatsRail product key and only delivered to the viewer
 * after payment.
 *
 * Rate-limited to discourage scraping; clients only need this once per view.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const limited = await rateLimit("envelope_fetch", 120);
  if (limited) return limited;

  const { id } = await params;

  if (!id || id.length === 0) {
    return NextResponse.json({ error: "Invalid envelope ID" }, { status: 400 });
  }

  try {
    const envelope = await prisma.encryptedEnvelope.findUnique({
      where: { id },
      select: { bytes: true, mimeType: true },
    });

    if (!envelope) {
      return NextResponse.json({ error: "Envelope not found" }, { status: 404 });
    }

    if (envelope.bytes.length > MAX_ENVELOPE_BYTES) {
      return NextResponse.json(
        { error: "Envelope exceeds size limit" },
        { status: 413 }
      );
    }

    return new Response(envelope.bytes, {
      headers: {
        // Always opaque/octet-stream — the bytes are AES-GCM ciphertext.
        // The original plaintext MIME is recorded on the EncryptedEnvelope
        // row but only the client (after DEK decrypt) can surface it.
        "Content-Type": "application/octet-stream",
        "Content-Length": envelope.bytes.length.toString(),
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: `"${id}"`,
      },
    });
  } catch (err) {
    console.error("envelopes.GET: failed to serve", err);
    return NextResponse.json({ error: "Failed to serve envelope" }, { status: 500 });
  }
}
