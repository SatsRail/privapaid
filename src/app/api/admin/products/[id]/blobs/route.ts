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

  const { id: productId } = await params;

  const mediaProducts = await prisma.mediaProduct.findMany({
    where: { satsrailProductId: productId },
  });

  // A product may be a ChannelProduct (one row with many encrypted media
  // entries) — surface those blobs too. The admin UI doesn't care which
  // shape the product takes; it just wants every blob covered by `productId`.
  const channelProducts = await prisma.channelProduct.findMany({
    where: { satsrailProductId: productId },
    include: { encryptedMedia: true },
  });

  type BlobRow = {
    mediaId: string;
    encryptedSourceUrl: string;
    keyFingerprint: string | null;
    createdAt: Date;
  };
  const rows: BlobRow[] = [
    ...mediaProducts.map((mp) => ({
      mediaId: mp.mediaId,
      encryptedSourceUrl: mp.encryptedSourceUrl,
      keyFingerprint: mp.keyFingerprint ?? null,
      createdAt: mp.createdAt,
    })),
    ...channelProducts.flatMap((cp) =>
      cp.encryptedMedia.map((cpm) => ({
        mediaId: cpm.mediaId,
        encryptedSourceUrl: cpm.encryptedSourceUrl,
        keyFingerprint: cpm.keyFingerprint ?? cp.keyFingerprint ?? null,
        createdAt: cpm.createdAt,
      }))
    ),
  ];

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
      key_fingerprint: row.keyFingerprint || null,
      created_at: row.createdAt.toISOString(),
    };
  });

  return NextResponse.json({ data: blobs });
}
