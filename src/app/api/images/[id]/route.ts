import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/images/[id]
 *
 * Legacy image-serving endpoint. The id is an opaque blob id returned by
 * POST /api/images. Two stores back this:
 *
 *   1. PreviewImage rows (the natural standalone image table).
 *   2. EncryptedPhotoBlob rows used by the POST shim as a generic blob
 *      store. (See comment on POST.)
 *
 * Owner-specific images (channel avatar, media thumbnail, logo) have
 * dedicated routes that read directly from the row's Bytes column —
 * e.g. /api/images/channel/<id>, /api/images/media-thumbnail/<id>,
 * /api/images/logo. This route only resolves standalone blob ids.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id || id.length === 0) {
    return NextResponse.json({ error: "Invalid image ID" }, { status: 400 });
  }

  try {
    // 1. PreviewImage — preview gallery uploads.
    const preview = await prisma.previewImage.findUnique({
      where: { id },
      select: { bytes: true, mimeType: true },
    });
    if (preview) {
      return new Response(preview.bytes, {
        headers: {
          "Content-Type": preview.mimeType,
          "Content-Length": preview.bytes.length.toString(),
          "Cache-Control": "public, max-age=31536000, immutable",
          ETag: `"${id}"`,
        },
      });
    }

    // 2. EncryptedPhotoBlob — generic blob store used by the POST shim.
    //    Bytes here are NOT encrypted when written via this endpoint, but
    //    photos uploaded through /api/admin/photos ARE encrypted (and
    //    should be served via /api/photos/[id] which knows that). We
    //    serve raw bytes either way; the caller is responsible for
    //    choosing the right endpoint.
    const blob = await prisma.encryptedPhotoBlob.findUnique({
      where: { id },
      select: { bytes: true, mimeType: true },
    });
    if (blob) {
      return new Response(blob.bytes, {
        headers: {
          "Content-Type": blob.mimeType,
          "Content-Length": blob.bytes.length.toString(),
          "Cache-Control": "public, max-age=31536000, immutable",
          ETag: `"${id}"`,
        },
      });
    }

    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  } catch (error) {
    console.error("Image serving error:", error);
    return NextResponse.json({ error: "Failed to serve image" }, { status: 500 });
  }
}
