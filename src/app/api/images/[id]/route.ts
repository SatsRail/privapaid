import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/images/[id]
 *
 * Generic image-serving endpoint. The id is an opaque blob id returned by
 * POST /api/images; bytes live in the `EncryptedPhotoBlob` table (used as
 * the generic blob store for thumbnails / preview gallery uploads — see
 * comment on POST). Photo content uploaded through /api/admin/photos goes
 * through this same table but is encrypted and should be served via
 * /api/photos/[id]; this route serves raw bytes so the caller picks.
 *
 * Owner-specific images (channel avatar, media thumbnail, logo) have
 * dedicated routes that read directly from the row's Bytes column.
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
