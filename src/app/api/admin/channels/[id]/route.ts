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
 *   1. Look up every Product (media-scoped + channel-scoped) under this channel
 *   2. Archive each linked SatsRail product (deleteProduct), tolerating per-product
 *      failures so a stuck product can't block the rest of the cleanup
 *   3. Delete Product rows (cascades to MediaEncryptedBlob)
 *   4. Delete all Media rows
 *   5. Delete the Channel row
 *   6. Audit-log with the full list of archived/failed product ids
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

  // Every Product covering this channel: direct-sale (mediaId in mediaIds)
  // OR channel-scoped (channelId == id).
  const productsToArchive = await prisma.product.findMany({
    where: {
      OR: [
        { channelId: id },
        ...(mediaIds.length > 0 ? [{ mediaId: { in: mediaIds } }] : []),
      ],
    },
    select: { id: true, satsrailProductId: true, channelId: true, mediaId: true },
  });

  const archivedProductIds: string[] = [];
  const archiveErrors: { productId: string; error: string }[] = [];
  let channelProductCount = 0;

  if (productsToArchive.length > 0) {
    channelProductCount = productsToArchive.filter((p) => p.channelId === id).length;
    const sk = await getMerchantKey();
    if (!sk) {
      console.warn(
        "channel.delete: no merchant key — skipping SatsRail archive for products:",
        productsToArchive.map((p) => p.satsrailProductId)
      );
    } else {
      for (const p of productsToArchive) {
        try {
          await satsrail.deleteProduct(sk, p.satsrailProductId);
          archivedProductIds.push(p.satsrailProductId);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          console.error(
            `channel.delete: failed to archive SatsRail product ${p.satsrailProductId}:`,
            message
          );
          archiveErrors.push({ productId: p.satsrailProductId, error: message });
        }
      }
    }
  }

  // Local cleanup — runs regardless of SatsRail success so we never end up
  // with dangling rows. MediaEncryptedBlob rows are cascade-deleted via the
  // Product → MediaEncryptedBlob relation.
  await prisma.product.deleteMany({
    where: { id: { in: productsToArchive.map((p) => p.id) } },
  });
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
      channel_product_count: channelProductCount,
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
