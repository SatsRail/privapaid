import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getEncryptedPhotosBucket } from "@/lib/gridfs";
import { rateLimit } from "@/lib/rate-limit";

/**
 * GET /api/photos/[id]
 *
 * Serves the AES-256-GCM ciphertext for an encrypted photo from the
 * `encrypted_photos` GridFS bucket. No auth required: the bytes are useless
 * without the DEK, which is itself encrypted under a SatsRail product key and
 * only delivered to the viewer after payment.
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

  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid photo ID" }, { status: 400 });
  }

  try {
    const bucket = await getEncryptedPhotosBucket();
    const files = await bucket.find({ _id: new ObjectId(id) }).toArray();

    if (files.length === 0) {
      return NextResponse.json({ error: "Photo not found" }, { status: 404 });
    }

    const downloadStream = bucket.openDownloadStream(new ObjectId(id));
    const chunks: Buffer[] = [];
    for await (const chunk of downloadStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    return new Response(buffer, {
      headers: {
        // Opaque ciphertext — the response is binary AES-GCM, not an image
        "Content-Type": "application/octet-stream",
        "Content-Length": buffer.length.toString(),
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: `"${id}"`,
      },
    });
  } catch (err) {
    console.error("photos.GET: failed to serve", err);
    return NextResponse.json({ error: "Failed to serve photo" }, { status: 500 });
  }
}
