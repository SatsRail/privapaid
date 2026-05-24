import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getEncryptedPhotosBucket } from "@/lib/gridfs";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Hard ceiling on the ciphertext we'll serve. Plaintext photos are capped
 * at 5 MB upstream; the GCM envelope adds ~28 bytes. 10 MB gives generous
 * headroom while preventing a corrupted or future feature from buffering
 * a multi-GB GridFS file into a single response.
 */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * GET /api/photos/[id]
 *
 * Serves the AES-256-GCM ciphertext for an encrypted photo from the
 * `encrypted_photos` GridFS bucket. No auth required: the bytes are useless
 * without the DEK, which is itself encrypted under a SatsRail product key and
 * only delivered to the viewer after payment.
 *
 * Rate-limited to discourage scraping; clients only need this once per view.
 *
 * Streams the ciphertext rather than buffering the whole file, so a future
 * large-photo feature can't OOM the process. We still set Content-Length
 * because GridFS metadata gives it to us up front and clients benefit.
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

    // GridFS metadata gives us the length up front. If it's missing
    // (mocks in tests, very old files), skip the cap check rather than
    // refusing the request — the in-flight memory upper bound is the
    // file size, and modern GridFS always reports length.
    const fileLength = files[0].length;
    if (typeof fileLength === "number" && fileLength > MAX_PHOTO_BYTES) {
      return NextResponse.json(
        { error: "Photo exceeds size limit" },
        { status: 413 }
      );
    }

    const downloadStream = bucket.openDownloadStream(new ObjectId(id));
    // Bridge the Node Readable into a Web ReadableStream via async
    // iteration. Works with the GridFS download stream (which is a real
    // Node Readable) and with the simpler async-iterator mocks used in
    // tests.
    const webStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of downloadStream as unknown as AsyncIterable<
            Buffer | string
          >) {
            controller.enqueue(
              chunk instanceof Buffer
                ? new Uint8Array(chunk)
                : new TextEncoder().encode(String(chunk))
            );
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
      cancel() {
        (downloadStream as { destroy?: () => void }).destroy?.();
      },
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${id}"`,
    };
    if (typeof fileLength === "number") {
      headers["Content-Length"] = fileLength.toString();
    }

    return new Response(webStream, { headers });
  } catch (err) {
    console.error("photos.GET: failed to serve", err);
    return NextResponse.json({ error: "Failed to serve photo" }, { status: 500 });
  }
}
