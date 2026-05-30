import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/images/[id]
 *
 * Generic image-serving endpoint. The id is an opaque row id returned by
 * POST /api/images; bytes live in the `MediaImage` table — thumbnails and
 * preview-gallery images for media. Distinct from /api/envelopes/[id], which
 * serves encrypted content envelopes.
 *
 * Only byte-backed rows serve here. Url-backed MediaImage rows (imported
 * direct links, bytes null) 404 — they are referenced by their externalUrl,
 * never via this route. Channel avatars and the settings logo keep their own
 * Bytes columns and dedicated routes.
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
    const image = await prisma.mediaImage.findUnique({
      where: { id },
      select: { bytes: true, mimeType: true },
    });
    if (image?.bytes) {
      return new Response(image.bytes, {
        headers: {
          "Content-Type": image.mimeType ?? "application/octet-stream",
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
