import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/images/media-thumbnail/[id]
 *
 * Serves a media item's thumbnail straight from the `Media.thumbnailBytes`
 * column (set on import). Distinct from /api/images/[id], which reads the
 * generic `PreviewImage` blob store for uploaded-before-the-row images.
 * The id here is the Media row id.
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
    const media = await prisma.media.findUnique({
      where: { id },
      select: { thumbnailBytes: true, thumbnailMimeType: true },
    });
    if (media?.thumbnailBytes) {
      return new Response(media.thumbnailBytes, {
        headers: {
          "Content-Type": media.thumbnailMimeType || "application/octet-stream",
          "Content-Length": media.thumbnailBytes.length.toString(),
          "Cache-Control": "public, max-age=31536000, immutable",
          ETag: `"${id}"`,
        },
      });
    }

    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  } catch (error) {
    console.error("Media thumbnail serving error:", error);
    return NextResponse.json({ error: "Failed to serve image" }, { status: 500 });
  }
}
