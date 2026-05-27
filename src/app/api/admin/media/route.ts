import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { encryptBytes, encryptSourceUrl } from "@/lib/content-encryption";
import { wrapDek, wrapDekFromBase64url } from "@/lib/content-dek";
import { type MediaBlob } from "@/lib/schemas/media-blob";

type MediaType = "video" | "audio" | "article" | "photo" | "podcast";

const ARTICLE_MIME = "text/markdown; charset=utf-8";

function bytesToBase64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Plan returned by `prepareCreatePlan` — pure (no DB writes). The caller
 * executes the envelope row creation + Media.create + channel mediaCount
 * increment in a single transaction.
 *
 * For envelope kinds (photo, article) `envelopeWrite` describes the new
 * EncryptedEnvelope row to insert; the caller patches its returned id into
 * `blobShape.envelopeId` before persisting Media.blob.
 */
type CreatePlan =
  | {
      kind: "url";
      blob: MediaBlob;
      productPlaintext: string;
    }
  | {
      kind: "photo";
      // Photo bytes were uploaded separately via /api/admin/photos; the
      // envelopeId already exists. No new envelope row to create here.
      blob: MediaBlob;
      productPlaintext: string;
    }
  | {
      kind: "article";
      envelopeWrite: { bytes: Buffer; mimeType: string };
      blobShape: { kind: "article"; encryptedDek: string; mimeType: string };
      productPlaintext: string;
    };

/**
 * Translate the API wire shape (`source_url`, `media_type`, optional `dek` for
 * photos) into a `CreatePlan` describing the DB writes to perform.
 *
 *   video/audio/podcast → source_url is the URL; product plaintext is the URL
 *   photo               → source_url is the EncryptedEnvelope id; dek is the
 *                         raw per-photo DEK; product plaintext is the raw DEK
 *   article             → source_url is the markdown body; the server mints a
 *                         per-article DEK and the caller writes a new
 *                         EncryptedEnvelope row inside a transaction
 *
 * For envelope kinds (photo, article) the DEK is wrapped under CONTENT_KEK
 * and stored on Media.blob.encryptedDek so rotation can recover without
 * SatsRail's old_key.
 */
function prepareCreatePlan(
  sourceUrl: string,
  mediaType: MediaType,
  dek: string | undefined,
  mimeTypeFromEnvelope: string | null
): CreatePlan | { error: string } {
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
      blob: {
        kind: "photo",
        envelopeId: sourceUrl,
        encryptedDek,
        mimeType: mimeTypeFromEnvelope ?? "application/octet-stream",
      },
      productPlaintext: dek,
    };
  }

  if (mediaType === "article") {
    // Server-side envelope encryption of markdown body. The raw DEK never
    // leaves this function — it's consumed by the per-product wrap below and
    // its only persisted form is the CONTENT_KEK-wrapped copy on Media.blob.
    const dekBytes = randomBytes(32);
    const dekBase64url = bytesToBase64url(dekBytes);
    const ciphertext = encryptBytes(Buffer.from(sourceUrl, "utf8"), dekBytes);
    let encryptedDek: string;
    try {
      encryptedDek = wrapDek(dekBytes);
    } catch (err) {
      return {
        error: `Failed to KEK-wrap article DEK: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }
    return {
      kind: "article",
      envelopeWrite: { bytes: ciphertext, mimeType: ARTICLE_MIME },
      blobShape: { kind: "article", encryptedDek, mimeType: ARTICLE_MIME },
      productPlaintext: dekBase64url,
    };
  }

  return {
    kind: "url",
    blob: { kind: "url", url: sourceUrl },
    productPlaintext: sourceUrl,
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

  // For photos, look up the EncryptedEnvelope row to recover its mimeType so
  // the Media.blob carries a meaningful value for the public envelope route.
  let mimeTypeFromEnvelope: string | null = null;
  if (mediaType === "photo") {
    const envelopeRow = await prisma.encryptedEnvelope.findUnique({
      where: { id: source_url },
      select: { mimeType: true },
    });
    mimeTypeFromEnvelope = envelopeRow?.mimeType ?? null;
  }

  const plan = prepareCreatePlan(source_url, mediaType, dek, mimeTypeFromEnvelope);
  if ("error" in plan) {
    return NextResponse.json({ error: plan.error }, { status: 422 });
  }

  // Auto-set position
  const maxPos = await prisma.media.findFirst({
    where: { channelId: channel_id },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  // Envelope + Media + channel.mediaCount must commit atomically:
  //   - If Media.create fails after envelope.create, the envelope row would be
  //     orphan (cleanup-cron-recoverable, but worth avoiding).
  //   - If channel.update fails after Media.create, mediaCount diverges from
  //     the actual count.
  const { media, productPlaintext } = await prisma.$transaction(async (tx) => {
    let blob: MediaBlob;
    let productPlaintext: string;
    if (plan.kind === "article") {
      const envelope = await tx.encryptedEnvelope.create({
        data: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          bytes: plan.envelopeWrite.bytes as any,
          mimeType: plan.envelopeWrite.mimeType,
        },
        select: { id: true },
      });
      blob = {
        ...plan.blobShape,
        envelopeId: envelope.id,
      };
      productPlaintext = plan.productPlaintext;
    } else {
      blob = plan.blob;
      productPlaintext = plan.productPlaintext;
    }

    const media = await tx.media.create({
      data: {
        channelId: channel_id,
        name: name.trim(),
        description: result.description || "",
        blob,
        mediaType,
        thumbnailUrl: result.thumbnail_url || "",
        position: result.position ?? (maxPos?.position ?? 0) + 1,
      },
    });

    await tx.channel.update({
      where: { id: channel_id },
      data: { mediaCount: { increment: 1 } },
    });

    return { media, productPlaintext };
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
          const encryptedSource = encryptSourceUrl(
            productPlaintext,
            key,
            cp.satsrailProductId
          );
          await prisma.mediaEncryptedBlob.create({
            data: {
              productId: cp.id,
              mediaId: media.id,
              encryptedSource,
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
