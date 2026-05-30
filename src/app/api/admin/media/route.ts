import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { createEnvelopeArtifacts, URL_ENVELOPE_MIME } from "@/lib/media-envelope";

type MediaType = "video" | "audio" | "article" | "photo" | "podcast";

const ARTICLE_MIME = "text/markdown; charset=utf-8";

/**
 * Plan returned by `prepareCreatePlan` — pure (no DB writes). The caller mints
 * the MediaEnvelope (url/article) or links the photo's pre-staged envelope, then
 * wraps the media DEK per product.
 *
 *   video/audio/podcast → payload is the source URL bytes; mint a new envelope
 *   article             → payload is the markdown body bytes; mint a new envelope
 *   photo               → bytes were uploaded via /api/admin/photos (the envelope
 *                         already exists, carrying its own wrappedDek); link it
 *                         and use the provided raw DEK as the per-product plaintext
 */
type CreatePlan =
  | { kind: "new-envelope"; payload: Buffer; mimeType: string }
  | { kind: "link-photo"; envelopeId: string; dekBase64url: string };

function prepareCreatePlan(
  sourceUrl: string,
  mediaType: MediaType,
  dek: string | undefined
): CreatePlan | { error: string } {
  if (mediaType === "photo") {
    if (!dek) {
      return { error: "dek is required for photo media" };
    }
    return { kind: "link-photo", envelopeId: sourceUrl, dekBase64url: dek };
  }

  if (mediaType === "article") {
    return {
      kind: "new-envelope",
      payload: Buffer.from(sourceUrl, "utf8"),
      mimeType: ARTICLE_MIME,
    };
  }

  // url-backed (video/audio/podcast): the source URL itself is the payload.
  return {
    kind: "new-envelope",
    payload: Buffer.from(sourceUrl, "utf8"),
    mimeType: URL_ENVELOPE_MIME,
  };
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
  // no other way to recover the per-photo DEK on the server. (Articles don't
  // need this check because the server mints their DEK locally.)
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

  const plan = prepareCreatePlan(source_url, mediaType, dek);
  if ("error" in plan) {
    return NextResponse.json({ error: plan.error }, { status: 422 });
  }

  // Auto-set position
  const maxPos = await prisma.media.findFirst({
    where: { channelId: channel_id },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  // Media + MediaEnvelope + channel.mediaCount must commit atomically:
  //   - Media is created first so the envelope's mediaId FK resolves.
  //   - If the envelope create/link fails, the Media row rolls back too.
  //   - If channel.update fails after Media.create, mediaCount diverges.
  const { media, dekBase64url } = await prisma.$transaction(async (tx) => {
    const media = await tx.media.create({
      data: {
        channelId: channel_id,
        name: name.trim(),
        description: result.description || "",
        mediaType,
        position: result.position ?? (maxPos?.position ?? 0) + 1,
      },
    });

    // Exactly one MediaEnvelope per media. url/article mint a fresh envelope;
    // photo links the row already staged by /api/admin/photos. The per-product
    // DEK plaintext (base64url) is the minted DEK or the request-supplied photo DEK.
    let dekBase64url: string;
    if (plan.kind === "new-envelope") {
      const artifacts = createEnvelopeArtifacts(plan.payload);
      await tx.mediaEnvelope.create({
        data: {
          mediaId: media.id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          bytes: artifacts.bytes as any,
          mimeType: plan.mimeType,
          wrappedDek: artifacts.wrappedDek,
        },
      });
      dekBase64url = artifacts.dekBase64url;
    } else {
      await tx.mediaEnvelope.update({
        where: { id: plan.envelopeId },
        data: { mediaId: media.id },
      });
      dekBase64url = plan.dekBase64url;
    }

    // Link images to this Media. Uploaded thumbnails/previews already exist as
    // free-standing MediaImage rows (created via POST /api/images with mediaId
    // null); here we claim them and set kind + position. updateMany (not
    // update) so a stale id links nothing instead of aborting the create. An
    // external thumbnail_url with no upload becomes a url-backed row.
    if (result.thumbnail_id) {
      await tx.mediaImage.updateMany({
        where: { id: result.thumbnail_id },
        data: { mediaId: media.id, kind: "thumbnail", position: 0 },
      });
    } else if (result.thumbnail_url) {
      await tx.mediaImage.create({
        data: {
          mediaId: media.id,
          kind: "thumbnail",
          externalUrl: result.thumbnail_url,
          position: 0,
        },
      });
    }

    const previewIds = result.preview_image_ids ?? [];
    for (let i = 0; i < previewIds.length; i++) {
      await tx.mediaImage.updateMany({
        where: { id: previewIds[i] },
        data: { mediaId: media.id, kind: "preview", position: i },
      });
    }

    await tx.channel.update({
      where: { id: channel_id },
      data: { mediaCount: { increment: 1 } },
    });

    return { media, dekBase64url };
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
          const encryptedDek = encryptSourceUrl(
            dekBase64url,
            key,
            cp.satsrailProductId
          );
          await prisma.mediaProduct.create({
            data: {
              productId: cp.id,
              mediaId: media.id,
              encryptedDek,
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

  // Thumbnail now lives in MediaImage; reconstruct the wire URL from the same
  // inputs we just linked (uploaded id → /api/images/<id>, else external url).
  const thumbnailUrl = result.thumbnail_id
    ? `/api/images/${result.thumbnail_id}`
    : result.thumbnail_url || "";

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
        thumbnail_url: thumbnailUrl,
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
