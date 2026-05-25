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

  const mediaIds = mediaProducts.map((mp) => mp.mediaId);
  const mediaItems = mediaIds.length > 0
    ? await prisma.media.findMany({
        where: { id: { in: mediaIds } },
        select: { id: true, name: true, mediaType: true, ref: true },
      })
    : [];

  const mediaMap = new Map(mediaItems.map((m) => [m.id, m]));

  const blobs = mediaProducts.map((mp) => {
    const media = mediaMap.get(mp.mediaId);
    return {
      media_id: mp.mediaId,
      media_name: media?.name || "Unknown",
      media_type: media?.mediaType || "unknown",
      media_ref: media?.ref ?? null,
      blob_preview: mp.encryptedSourceUrl
        ? `${mp.encryptedSourceUrl.slice(0, 24)}...${mp.encryptedSourceUrl.slice(-8)}`
        : null,
      blob_length: mp.encryptedSourceUrl?.length ?? 0,
      key_fingerprint: mp.keyFingerprint || null,
      created_at: mp.createdAt.toISOString(),
    };
  });

  return NextResponse.json({ data: blobs });
}
