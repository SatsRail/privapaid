import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
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
 * Serves the AES-256-GCM ciphertext for a media's content from the
 * `MediaEnvelope` table (the source URL for url media, the content bytes for
 * photo/article). No auth required: the bytes are useless without the DEK,
 * which is itself encrypted under a SatsRail product key and only delivered to
 * the viewer after payment.
 *
 * Rate-limited to discourage scraping; clients only need this once per view.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const limited = await rateLimit("envelope_fetch", 120);
  if (limited) return limited;

  const { id } = await params;

  if (!id || id.length === 0) {
    return NextResponse.json({ error: "Invalid envelope ID" }, { status: 400 });
  }

  try {
    // Probe the size in SQL before fetching: a corrupted multi-GB row must be
    // rejected without ever buffering its bytes into process memory.
    const sized = await prisma.$queryRaw<Array<{ len: number }>>`
      SELECT octet_length("bytes")::int AS len
      FROM "MediaEnvelope"
      WHERE "id" = ${id}
    `;

    if (sized.length === 0) {
      return NextResponse.json({ error: "Envelope not found" }, { status: 404 });
    }

    if (sized[0].len > MAX_ENVELOPE_BYTES) {
      return NextResponse.json(
        { error: "Envelope exceeds size limit" },
        { status: 413 }
      );
    }

    const envelope = await prisma.mediaEnvelope.findUnique({
      where: { id },
      select: { bytes: true },
    });

    if (!envelope) {
      return NextResponse.json({ error: "Envelope not found" }, { status: 404 });
    }

    // Content-addressed ETag. The envelope id is stable, but its bytes are
    // MUTABLE — re-saving a url media's source (or editing an article body)
    // re-encrypts the payload in place under the same id. An id-based
    // `immutable` cache therefore served stale content forever: a re-saved url
    // would keep playing the OLD source in every browser/CDN that had fetched
    // it once. Hashing the bytes makes the ETag change exactly when the content
    // changes, so revalidation returns fresh bytes the moment it's edited.
    const etag = `"${createHash("sha256").update(envelope.bytes).digest("base64url").slice(0, 22)}"`;
    const cacheControl = "public, max-age=0, must-revalidate";

    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": cacheControl },
      });
    }

    return new Response(envelope.bytes, {
      headers: {
        // Always opaque/octet-stream — the bytes are AES-GCM ciphertext.
        // The original plaintext MIME is recorded on the MediaEnvelope
        // row but only the client (after DEK decrypt) can surface it.
        "Content-Type": "application/octet-stream",
        "Content-Length": envelope.bytes.length.toString(),
        // Revalidate every view: a cheap 304 when unchanged (content ETag),
        // fresh bytes the instant the content changes. NOT `immutable`.
        "Cache-Control": cacheControl,
        ETag: etag,
      },
    });
  } catch (err) {
    console.error("envelopes.GET: failed to serve", err);
    return NextResponse.json({ error: "Failed to serve envelope" }, { status: 500 });
  }
}
