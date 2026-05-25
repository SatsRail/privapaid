import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { encryptSourceUrl } from "@/lib/content-encryption";
import type { Prisma } from "@prisma/client";

async function reEncryptBlobs(
  mediaId: string,
  channelId: string,
  newSourceUrl: string
): Promise<void> {
  try {
    const sk = await getMerchantKey();
    if (!sk) return;

    const mediaProducts = await prisma.mediaProduct.findMany({
      where: { mediaId },
    });
    for (const mp of mediaProducts) {
      const { key } = await satsrail.getProductKey(sk, mp.satsrailProductId);
      const encrypted = encryptSourceUrl(newSourceUrl, key, mp.satsrailProductId);
      await prisma.mediaProduct.update({
        where: { id: mp.id },
        data: { encryptedSourceUrl: encrypted },
      });
    }

    const channelProducts = await prisma.channelProduct.findMany({
      where: {
        channelId,
        encryptedMedia: { some: { mediaId } },
      },
      include: { encryptedMedia: { where: { mediaId } } },
    });
    for (const cp of channelProducts) {
      const { key } = await satsrail.getProductKey(sk, cp.satsrailProductId);
      const encrypted = encryptSourceUrl(newSourceUrl, key, cp.satsrailProductId);
      for (const entry of cp.encryptedMedia) {
        await prisma.channelProductMedia.update({
          where: { id: entry.id },
          data: { encryptedSourceUrl: encrypted },
        });
      }
    }
  } catch (err) {
    console.error("Failed to re-encrypt after sourceUrl change:", err);
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const media = await prisma.media.findUnique({ where: { id } });
  if (!media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const products = await prisma.mediaProduct.findMany({
    where: { mediaId: id },
    select: { satsrailProductId: true, createdAt: true },
  });

  return NextResponse.json({
    data: {
      ...media,
      product_ids: products.map((p) => p.satsrailProductId),
      media_products: products,
    },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;
  const validated = await validateBody(req, schemas.mediaUpdate);
  if (isValidationError(validated)) return validated;

  const { id } = await params;

  const updates: Prisma.MediaUpdateInput = {};
  if (validated.name !== undefined) updates.name = validated.name;
  if (validated.description !== undefined) updates.description = validated.description;
  if (validated.source_url !== undefined) updates.sourceUrl = validated.source_url;
  if (validated.media_type !== undefined) updates.mediaType = validated.media_type;
  if (validated.thumbnail_url !== undefined) updates.thumbnailUrl = validated.thumbnail_url;
  if (validated.position !== undefined) updates.position = validated.position;

  const oldMedia = validated.source_url !== undefined
    ? await prisma.media.findUnique({
        where: { id },
        select: { sourceUrl: true },
      })
    : null;

  let media;
  try {
    media = await prisma.media.update({ where: { id }, data: updates });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Re-encrypt blobs if sourceUrl changed
  if (oldMedia && validated.source_url && validated.source_url !== oldMedia.sourceUrl) {
    await reEncryptBlobs(media.id, media.channelId, validated.source_url);
  }

  return NextResponse.json({ data: media });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const media = await prisma.media.findUnique({ where: { id } });
  if (!media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const wasAlreadySoftDeleted = media.deletedAt !== null;

  // Archive corresponding SatsRail products for individual MediaProducts.
  // ChannelProducts are NOT archived — they cover the whole channel; we only
  // pull this media's entry from their encryptedMedia rows (below).
  const mediaProducts = await prisma.mediaProduct.findMany({
    where: { mediaId: media.id },
    select: { satsrailProductId: true },
  });
  const archivedProductIds: string[] = [];
  const archiveErrors: { productId: string; error: string }[] = [];

  if (mediaProducts.length > 0) {
    const sk = await getMerchantKey();
    if (!sk) {
      console.warn(
        "media.delete: no merchant key — skipping SatsRail archive for products:",
        mediaProducts.map((mp) => mp.satsrailProductId)
      );
    } else {
      for (const mp of mediaProducts) {
        try {
          await satsrail.deleteProduct(sk, mp.satsrailProductId);
          archivedProductIds.push(mp.satsrailProductId);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          console.error(
            `media.delete: failed to archive SatsRail product ${mp.satsrailProductId}:`,
            message
          );
          archiveErrors.push({ productId: mp.satsrailProductId, error: message });
        }
      }
    }

    await prisma.mediaProduct.deleteMany({ where: { mediaId: media.id } });
  }

  // Remove this media from any ChannelProduct's encryptedMedia entries.
  try {
    await prisma.channelProductMedia.deleteMany({
      where: {
        mediaId: media.id,
        channelProduct: { channelId: media.channelId },
      },
    });
  } catch (err) {
    console.error("Failed to clean up channel product blobs:", err);
  }

  // Decrement channel media count — but only if it wasn't already soft-deleted
  // (legacy state where decrement already happened).
  if (!wasAlreadySoftDeleted) {
    await prisma.channel.update({
      where: { id: media.channelId },
      data: { mediaCount: { decrement: 1 } },
    });
  }

  // For photo media, clean up the EncryptedPhotoBlob so we don't leak storage.
  // The bytes are useless without a DEK envelope (which we just deleted along
  // with MediaProduct), but they still occupy space.
  if (media.mediaType === "photo" && media.sourceUrl) {
    try {
      await prisma.encryptedPhotoBlob.delete({ where: { id: media.sourceUrl } });
    } catch (err) {
      console.error(
        `media.delete: failed to remove encrypted photo blob ${media.sourceUrl}:`,
        err
      );
      // Continue — orphaned bytes are a soft failure, not a blocking one
    }
  }

  // Hard-delete the media row. SatsRail keeps the transaction history; the
  // audit log below records the deletion event independently of the row.
  await prisma.media.delete({ where: { id: media.id } });

  audit({
    actorId: auth.id,
    actorEmail: auth.email,
    actorType: "admin",
    action: "media.delete",
    targetType: "media",
    targetId: id,
    details: {
      name: media.name,
      channel_id: media.channelId,
      archived_product_ids: archivedProductIds,
      archive_errors: archiveErrors.length > 0 ? archiveErrors : undefined,
      was_already_soft_deleted: wasAlreadySoftDeleted,
    },
  });

  return NextResponse.json({
    success: true,
    archived_product_ids: archivedProductIds,
  });
}
