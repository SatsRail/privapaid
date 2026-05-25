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
import {
  parseMediaBlob,
  plaintextForEncryption,
  type MediaBlob,
} from "@/lib/schemas/media-blob";

type MediaType = "video" | "audio" | "article" | "photo" | "podcast";

/**
 * Translate the API wire shape (`source_url`, `media_type`, optional `dek` for
 * photos) into the Media.blob JSONB payload. `source_url` is overloaded today:
 *
 *   video/audio/podcast → URL
 *   article             → markdown body
 *   photo               → EncryptedPhotoBlob.id (the ciphertext pointer)
 *
 * For photos, `dek` is the per-photo DEK from the upload response, wrapped
 * under PHOTO_KEK before persisting on the blob.
 */
function buildBlobForCreate(
  sourceUrl: string,
  mediaType: MediaType,
  dek: string | undefined,
  mimeTypeFromBlob: string | null
): MediaBlob | { error: string } {
  if (mediaType === "article") {
    return { kind: "markdown", body: sourceUrl };
  }
  if (mediaType === "photo") {
    if (!dek) {
      return { error: "dek is required for photo media" };
    }
    let encryptedDek: string;
    try {
      encryptedDek = wrapDekFromBase64url(dek);
    } catch (err) {
      return {
        error: `Failed to KEK-wrap photo DEK: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }
    return {
      kind: "photo",
      blobId: sourceUrl,
      encryptedDek,
      mimeType: mimeTypeFromBlob ?? "application/octet-stream",
    };
  }
  return { kind: "url", url: sourceUrl };
}

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

  // Attach product IDs to each media item (direct-sale only — channel-scoped
  // products are not surfaced here because the admin UI lists them per-channel).
  const mediaIds = mediaItems.map((m) => m.id);
  const directProducts = mediaIds.length > 0
    ? await prisma.product.findMany({
        where: { mediaId: { in: mediaIds } },
        select: { mediaId: true, satsrailProductId: true },
      })
    : [];

  const productMap = new Map<string, string[]>();
  for (const p of directProducts) {
    if (!p.mediaId) continue;
    if (!productMap.has(p.mediaId)) productMap.set(p.mediaId, []);
    productMap.get(p.mediaId)!.push(p.satsrailProductId);
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
  const mediaType: MediaType = (media_type || "video") as MediaType;

  const channel = await prisma.channel.findUnique({ where: { id: channel_id } });
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  // For photo media added to a channel with existing channel-scoped products,
  // we MUST have the DEK in hand to wrap it under each product key — there's
  // no other way to recover the per-photo DEK on the server.
  if (mediaType === "photo") {
    const existingChannelProducts = await prisma.product.count({
      where: { channelId: channel_id },
    });
    if (existingChannelProducts > 0 && !dek) {
      return NextResponse.json(
        { error: "dek is required for photo media when the channel already has products" },
        { status: 422 }
      );
    }
  }

  // For photos, look up the EncryptedPhotoBlob row to recover its mimeType
  // so the Media.blob carries a meaningful value for the public photo route.
  let mimeTypeFromBlob: string | null = null;
  if (mediaType === "photo") {
    const blobRow = await prisma.encryptedPhotoBlob.findUnique({
      where: { id: source_url },
      select: { mimeType: true },
    });
    mimeTypeFromBlob = blobRow?.mimeType ?? null;
  }

  const blobOrError = buildBlobForCreate(source_url, mediaType, dek, mimeTypeFromBlob);
  if ("error" in blobOrError) {
    return NextResponse.json({ error: blobOrError.error }, { status: 422 });
  }
  const blob = blobOrError;

  // Auto-set position
  const maxPos = await prisma.media.findFirst({
    where: { channelId: channel_id },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const ref = await getNextRef("media");

  const media = await prisma.media.create({
    data: {
      ref,
      channelId: channel_id,
      name: name.trim(),
      description: result.description || "",
      blob,
      mediaType,
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

  // Encrypt for existing channel-scoped products
  try {
    const channelProductDocs = await prisma.product.findMany({
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
          const plaintext = mediaType === "photo" ? (dek as string) : source_url;
          const encryptedSourceUrl = encryptSourceUrl(plaintext, key, cp.satsrailProductId);
          await prisma.mediaEncryptedBlob.create({
            data: {
              productId: cp.id,
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

  // Surface a stable wire shape that still exposes source_url for older clients.
  // Server-internal storage is the JSONB blob; the wire shape is a translation.
  return NextResponse.json(
    {
      data: {
        _id: media.id,
        ref: media.ref,
        channel_id: media.channelId,
        name: media.name,
        description: media.description,
        source_url,
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
