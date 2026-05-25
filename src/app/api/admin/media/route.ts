import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getNextRef } from "@/models/Counter";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { wrapDekFromBase64url } from "@/lib/photo-dek";

export async function GET(req: NextRequest) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;
  const { searchParams } = new URL(req.url);
  const channelId = searchParams.get("channel_id");

  if (!channelId) {
    return NextResponse.json(
      { error: "channel_id is required" },
      { status: 422 }
    );
  }

  const mediaItems = await prisma.media.findMany({
    where: { channelId, deletedAt: null },
    orderBy: { position: "asc" },
  });

  // Attach product IDs to each media item
  const mediaIds = mediaItems.map((m) => m.id);
  const mediaProducts = mediaIds.length > 0
    ? await prisma.mediaProduct.findMany({
        where: { mediaId: { in: mediaIds } },
        select: { mediaId: true, satsrailProductId: true },
      })
    : [];

  const productMap = new Map<string, string[]>();
  for (const mp of mediaProducts) {
    if (!productMap.has(mp.mediaId)) productMap.set(mp.mediaId, []);
    productMap.get(mp.mediaId)!.push(mp.satsrailProductId);
  }

  const data = mediaItems.map((m) => ({
    ...m,
    product_ids: productMap.get(m.id) || [],
  }));

  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;
  const result = await validateBody(req, schemas.mediaCreate);
  if (isValidationError(result)) return result;

  const { channel_id, name, source_url, media_type, dek } = result;

  const channel = await prisma.channel.findUnique({ where: { id: channel_id } });
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  // For photo media added to a channel with existing ChannelProducts, we MUST
  // have the DEK in hand to wrap it under each product key — there's no other
  // way to recover the per-photo DEK on the server.
  if (media_type === "photo") {
    const existingChannelProducts = await prisma.channelProduct.count({
      where: { channelId: channel_id },
    });
    if (existingChannelProducts > 0 && !dek) {
      return NextResponse.json(
        { error: "dek is required for photo media when the channel already has products" },
        { status: 422 }
      );
    }
  }

  // Auto-set position
  const maxPos = await prisma.media.findFirst({
    where: { channelId: channel_id },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const ref = await getNextRef("media");

  // Wrap the per-photo DEK under the operator's PHOTO_KEK before persisting
  // it on Media. This eliminates the SatsRail round-trip when later product
  // creations need to recover the DEK, and survives the "no MediaProduct
  // exists yet" case that previously blocked channel-product creation for
  // photos. Failure to wrap is non-fatal — the legacy "recover via another
  // MediaProduct" path stays as a fallback.
  let encryptedDek: string | undefined;
  if (media_type === "photo" && dek) {
    try {
      encryptedDek = wrapDekFromBase64url(dek as string);
    } catch (err) {
      console.error("Failed to KEK-wrap photo DEK:", err);
    }
  }

  const media = await prisma.media.create({
    data: {
      ref,
      channelId: channel_id,
      name: name.trim(),
      description: result.description || "",
      sourceUrl: source_url,
      mediaType: media_type || "video",
      ...(encryptedDek ? { encryptedDek } : {}),
      thumbnailUrl: result.thumbnail_url || "",
      position: result.position ?? (maxPos?.position ?? 0) + 1,
    },
  });

  audit({
    actorId: auth.id,
    actorEmail: auth.email,
    actorType: "admin",
    action: "media.create",
    targetType: "media",
    targetId: media.id,
    details: { name: media.name, channel_id },
  });

  // Increment channel media count
  await prisma.channel.update({
    where: { id: channel_id },
    data: { mediaCount: { increment: 1 } },
  });

  // Encrypt for existing channel products
  try {
    const channelProductDocs = await prisma.channelProduct.findMany({
      where: { channelId: channel_id },
    });
    if (channelProductDocs.length > 0) {
      const sk = await getMerchantKey();
      if (sk) {
        for (const cp of channelProductDocs) {
          const { key } = await satsrail.getProductKey(
            sk,
            cp.satsrailProductId
          );
          // For photo media (envelope encryption), wrap the per-photo DEK
          // rather than the source_url (which is just a blob pointer).
          const plaintext = media_type === "photo" ? (dek as string) : source_url;
          const encryptedSourceUrl = encryptSourceUrl(plaintext, key, cp.satsrailProductId);
          await prisma.channelProductMedia.create({
            data: {
              channelProductId: cp.id,
              mediaId: media.id,
              encryptedSourceUrl,
              keyFingerprint: cp.keyFingerprint,
            },
          });
        }
      }
    }
  } catch (err) {
    // Media creation succeeds even if channel product encryption fails
    console.error("Failed to encrypt for channel products:", err);
  }

  return NextResponse.json(
    {
      data: {
        _id: media.id,
        ref: media.ref,
        channel_id: media.channelId,
        name: media.name,
        description: media.description,
        source_url: media.sourceUrl,
        media_type: media.mediaType,
        thumbnail_url: media.thumbnailUrl,
        position: media.position,
        views_count: media.viewsCount,
        comments_count: media.commentsCount,
        likes_count: media.likesCount,
        shares_count: media.sharesCount,
        created_at: media.createdAt,
        updated_at: media.updatedAt,
      },
    },
    { status: 201 }
  );
}
