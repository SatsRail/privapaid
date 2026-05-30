import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/images/channel/[id]
 *
 * Serves a channel's avatar straight from the `Channel.profileImageBytes`
 * column (set on import). Distinct from /api/images/[id], which reads the
 * `MediaImage` table (media thumbnails + preview-gallery images).
 * The id here is the Channel row id.
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
    const channel = await prisma.channel.findUnique({
      where: { id },
      select: { profileImageBytes: true, profileImageMimeType: true },
    });
    if (channel?.profileImageBytes) {
      return new Response(channel.profileImageBytes, {
        headers: {
          "Content-Type":
            channel.profileImageMimeType || "application/octet-stream",
          "Content-Length": channel.profileImageBytes.length.toString(),
          "Cache-Control": "public, max-age=31536000, immutable",
          ETag: `"${id}"`,
        },
      });
    }

    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  } catch (error) {
    console.error("Channel avatar serving error:", error);
    return NextResponse.json({ error: "Failed to serve image" }, { status: 500 });
  }
}
