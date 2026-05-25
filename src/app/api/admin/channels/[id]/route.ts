import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import type { Prisma } from "@prisma/client";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const channel = await prisma.channel.findUnique({
    where: { id },
    include: { category: { select: { name: true } } },
  });
  if (!channel) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ data: channel });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const validated = await validateBody(req, schemas.channelUpdate);
  if (isValidationError(validated)) return validated;

  const { id } = await params;

  const updates: Prisma.ChannelUpdateInput = {};
  if (validated.name !== undefined) updates.name = validated.name;
  if (validated.slug !== undefined) updates.slug = validated.slug;
  if (validated.bio !== undefined) updates.bio = validated.bio;
  if (validated.category_id !== undefined) {
    updates.category = validated.category_id
      ? { connect: { id: validated.category_id } }
      : { disconnect: true };
  }
  if (validated.nsfw !== undefined) updates.nsfw = validated.nsfw;
  if (validated.profile_image_url !== undefined) updates.profileImageUrl = validated.profile_image_url;
  if (validated.social_links !== undefined) updates.socialLinks = validated.social_links as Prisma.InputJsonValue;
  if (validated.active !== undefined) updates.active = validated.active;
  if (validated.is_live !== undefined) updates.isLive = validated.is_live;
  if (validated.stream_url !== undefined) updates.streamUrl = validated.stream_url;

  // Check slug uniqueness
  if (validated.slug) {
    const existing = await prisma.channel.findFirst({
      where: { slug: validated.slug, NOT: { id } },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json({ error: "Slug already taken" }, { status: 422 });
    }
  }

  let channel;
  try {
    channel = await prisma.channel.update({
      where: { id },
      data: updates,
      include: { category: { select: { name: true } } },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ data: channel });
}

/**
 * Hard-delete a channel and cascade through all nested resources.
 *
 * Cascade order (mirrors single-media DELETE at /api/admin/media/[id]):
 *   1. Look up every MediaProduct + ChannelProduct under this channel
 *   2. Archive each linked SatsRail product (deleteProduct), tolerating per-product
 *      failures so a stuck product can't block the rest of the cleanup
 *   3. Delete MediaProduct rows
 *   4. Delete ChannelProduct rows
 *   5. Delete all Media rows
 *   6. Delete the Channel row
 *   7. Audit-log with the full list of archived/failed product ids
 *
 * If the merchant key is missing we still complete the local cleanup but
 * leave the SatsRail products intact (logged + reported in the audit entry).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  const channel = await prisma.channel.findUnique({ where: { id } });
  if (!channel) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const mediaDocs = await prisma.media.findMany({
    where: { channelId: id },
    select: { id: true, name: true },
  });
  const mediaIds = mediaDocs.map((m) => m.id);

  const mediaProducts = mediaIds.length > 0
    ? await prisma.mediaProduct.findMany({
        where: { mediaId: { in: mediaIds } },
        select: { satsrailProductId: true },
      })
    : [];

  const channelProducts = await prisma.channelProduct.findMany({
    where: { channelId: id },
    select: { satsrailProductId: true },
  });

  const productIdsToArchive: string[] = [
    ...mediaProducts.map((mp) => mp.satsrailProductId),
    ...channelProducts.map((cp) => cp.satsrailProductId),
  ];

  const archivedProductIds: string[] = [];
  const archiveErrors: { productId: string; error: string }[] = [];

  if (productIdsToArchive.length > 0) {
    const sk = await getMerchantKey();
    if (!sk) {
      console.warn(
        "channel.delete: no merchant key — skipping SatsRail archive for products:",
        productIdsToArchive
      );
    } else {
      for (const productId of productIdsToArchive) {
        try {
          await satsrail.deleteProduct(sk, productId);
          archivedProductIds.push(productId);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          console.error(
            `channel.delete: failed to archive SatsRail product ${productId}:`,
            message
          );
          archiveErrors.push({ productId, error: message });
        }
      }
    }
  }

  // Local cleanup — runs regardless of SatsRail success so we never end up
  // with dangling rows. ChannelProductMedia is cascade-deleted via the
  // ChannelProduct → ChannelProductMedia relation.
  if (mediaIds.length > 0) {
    await prisma.mediaProduct.deleteMany({ where: { mediaId: { in: mediaIds } } });
  }
  await prisma.channelProduct.deleteMany({ where: { channelId: id } });
  await prisma.media.deleteMany({ where: { channelId: id } });
  await prisma.channel.delete({ where: { id } });

  audit({
    actorId: auth.id,
    actorEmail: auth.email,
    actorType: "admin",
    action: "channel.delete",
    targetType: "channel",
    targetId: id,
    details: {
      name: channel.name,
      slug: channel.slug,
      ref: channel.ref,
      media_count: mediaDocs.length,
      channel_product_count: channelProducts.length,
      archived_product_ids: archivedProductIds,
      archive_errors: archiveErrors.length > 0 ? archiveErrors : undefined,
    },
  });

  return NextResponse.json({
    success: true,
    media_deleted: mediaDocs.length,
    archived_product_ids: archivedProductIds,
    archive_errors: archiveErrors.length > 0 ? archiveErrors : undefined,
  });
}
