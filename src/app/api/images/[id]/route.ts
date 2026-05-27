import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/images/[id]
 *
 * Generic image-serving endpoint. The id is an opaque row id returned by
 * POST /api/images; bytes live in the `PreviewImage` table — the generic
 * blob store for free-standing image uploads (preview gallery, thumbnails
 * uploaded before the owning row exists, etc.). Distinct from
 * /api/envelopes/[id], which serves encrypted content envelopes.
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
    const image = await prisma.previewImage.findUnique({
      where: { id },
      select: { bytes: true, mimeType: true },
    });
    if (image) {
      return new Response(image.bytes, {
        headers: {
          "Content-Type": image.mimeType,
          "Content-Length": image.bytes.length.toString(),
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
