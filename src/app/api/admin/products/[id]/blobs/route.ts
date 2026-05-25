import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;

  const { id: satsrailProductId } = await params;

  // Find the local Product mirror and load every MediaEncryptedBlob row
  // attached to it. Works for both channel-scoped and media-scoped products
  // since the shape is uniform now.
  const product = await prisma.product.findUnique({
    where: { satsrailProductId },
    select: {
      keyFingerprint: true,
      mediaEncryptedBlobs: {
        select: {
          mediaId: true,
          encryptedSourceUrl: true,
          keyFingerprint: true,
          createdAt: true,
        },
      },
    },
  });

  if (!product) {
    return NextResponse.json({ data: [] });
  }

  const rows = product.mediaEncryptedBlobs;
  const mediaIds = [...new Set(rows.map((r) => r.mediaId))];
  const mediaItems = mediaIds.length > 0
    ? await prisma.media.findMany({
        where: { id: { in: mediaIds } },
        select: { id: true, name: true, mediaType: true, ref: true },
      })
    : [];

  const mediaMap = new Map(mediaItems.map((m) => [m.id, m]));

  const blobs = rows.map((row) => {
    const media = mediaMap.get(row.mediaId);
    return {
      media_id: row.mediaId,
      media_name: media?.name || "Unknown",
      media_type: media?.mediaType || "unknown",
      media_ref: media?.ref ?? null,
      blob_preview: row.encryptedSourceUrl
        ? `${row.encryptedSourceUrl.slice(0, 24)}...${row.encryptedSourceUrl.slice(-8)}`
        : null,
      blob_length: row.encryptedSourceUrl?.length ?? 0,
      key_fingerprint: row.keyFingerprint ?? product.keyFingerprint ?? null,
      created_at: row.createdAt.toISOString(),
    };
  });

  return NextResponse.json({ data: blobs });
}
