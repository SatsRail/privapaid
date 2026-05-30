import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { encryptBytes, encryptSourceUrl } from "@/lib/content-encryption";
import { unwrapDek } from "@/lib/content-dek";
import {
  parseMediaBlob,
  type MediaBlob,
} from "@/lib/schemas/media-blob";
import type { Prisma } from "@prisma/client";

type MediaType = "video" | "audio" | "article" | "photo" | "podcast";
const ARTICLE_MIME = "text/markdown; charset=utf-8";

/**
 * Group MediaTypes by the underlying blob shape they require. Cross-class
 * changes via PATCH are rejected (see PATCH handler) — they'd leave the
 * Media.blob payload mismatched with Media.mediaType.
 */
function kindClassFor(mediaType: MediaType): "url" | "photo" | "article" {
  switch (mediaType) {
    case "photo":
      return "photo";
    case "article":
      return "article";
    default:
      return "url";
  }
}

/**
 * Plan returned by `prepareUpdatePlan` — pure (no DB writes). The PATCH
 * handler executes the envelope row creation + Media.update in a single
 * transaction so a partial failure can't orphan the new envelope.
 */
type UpdatePlan =
  | { kind: "noop" }
  | {
      kind: "url";
      blob: MediaBlob;
      perProductPlaintext: string | null;
    }
  | {
      kind: "article";
      envelopeWrite: { bytes: Buffer; mimeType: string };
      encryptedDek: string;
      mimeType: string;
    };

/**
 * Reconcile the Media row + envelope ciphertext for a source_url change.
 *
 * Article PATCH allocates a NEW EncryptedEnvelope row each time (content-
 * addressed URLs) and points Media.blob.envelopeId at it. This keeps the
 * `/api/envelopes/[id]` cache header `immutable` correct — a CDN that
 * fetched the old id can keep serving stale bytes forever and that's fine
 * because nothing references the old id anymore. The old row becomes
 * orphan and is reaped by the envelope-cleanup cron.
 *
 * Photo blobs are immutable on PATCH — the photo is identified by its
 * envelope id at upload time and a body re-upload requires re-running
 * /api/admin/photos to mint a fresh DEK + envelope.
 */
function prepareUpdatePlan(
  sourceUrl: string,
  newType: MediaType,
  existingBlob: MediaBlob | null
): UpdatePlan | { error: string } {
  if (newType === "photo") {
    if (existingBlob && existingBlob.kind !== "photo") {
      return {
        error:
          "Cannot change media_type to photo via PATCH; delete and recreate the media item",
      };
    }
    return { kind: "noop" };
  }

  if (newType === "article") {
    if (!existingBlob || existingBlob.kind !== "article") {
      return {
        error:
          "Cannot change media_type to article via PATCH; delete and recreate the media item",
      };
    }
    // Re-use the existing DEK so per-product blobs stay valid, but allocate
    // a fresh envelope row so the public URL is content-addressed and any
    // cached old ciphertext stays linked to the old (now orphan) id.
    let dekBytes: Buffer;
    try {
      dekBytes = unwrapDek(existingBlob.encryptedDek);
    } catch (err) {
      return {
        error: `Failed to unwrap article DEK: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }
    const ciphertext = encryptBytes(Buffer.from(sourceUrl, "utf8"), dekBytes);
    return {
      kind: "article",
      envelopeWrite: { bytes: ciphertext, mimeType: ARTICLE_MIME },
      encryptedDek: existingBlob.encryptedDek,
      mimeType: ARTICLE_MIME,
    };
  }

  // url-backed kinds (video/audio/podcast)
  if (existingBlob && existingBlob.kind !== "url") {
    return {
      error: `Cannot change media_type to ${newType} via PATCH; delete and recreate the media item`,
    };
  }
  return {
    kind: "url",
    blob: { kind: "url", url: sourceUrl },
    perProductPlaintext: sourceUrl,
  };
}

async function reEncryptBlobs(
  mediaId: string,
  newPlaintext: string
): Promise<void> {
  try {
    const sk = await getMerchantKey();
    if (!sk) return;

    // All blob rows for this media, grouped by product (so we fetch each key once).
    const blobs = await prisma.mediaEncryptedBlob.findMany({
      where: { mediaId },
      include: { product: { select: { id: true, satsrailProductId: true } } },
    });

    // Fetch each unique key once.
    const keyCache = new Map<string, string>();
    for (const b of blobs) {
      const pid = b.product.satsrailProductId;
      if (!keyCache.has(pid)) {
        const { key } = await satsrail.getProductKey(sk, pid);
        keyCache.set(pid, key);
      }
    }

    for (const b of blobs) {
      const pid = b.product.satsrailProductId;
      const key = keyCache.get(pid)!;
      const encrypted = encryptSourceUrl(newPlaintext, key, pid);
      await prisma.mediaEncryptedBlob.update({
        where: { id: b.id },
        data: { encryptedSource: encrypted },
      });
    }
  } catch (err) {
    console.error("Failed to re-encrypt after source change:", err);
  }
}

/**
 * Reconcile a Media's thumbnail + preview MediaImage rows to the desired state
 * submitted by an edit. PATCH is partial, so only dimensions present in the
 * payload are touched: pass thumbnailId/thumbnailUrl to set the thumbnail and
 * previewIds to set the gallery. Uploaded ids are claimed from the free-standing
 * pool (mediaId null) or reordered in place; rows of a reconciled kind that are
 * no longer referenced are deleted (freeing their bytes).
 *
 * Reassign-then-prune ordering lets an image move between kinds (e.g. promoting
 * a preview to the thumbnail) without being deleted mid-flight. The where guard
 * `mediaId IS NULL OR mediaId = this` ensures we never steal another media's row.
 */
async function reconcileMediaImages(
  tx: Prisma.TransactionClient,
  mediaId: string,
  desired: { thumbnailId?: string; thumbnailUrl?: string; previewIds?: string[] }
): Promise<void> {
  const thumbnailProvided =
    desired.thumbnailId !== undefined || desired.thumbnailUrl !== undefined;
  const previewsProvided = desired.previewIds !== undefined;
  if (!thumbnailProvided && !previewsProvided) return;

  // 1. Claim / reorder the rows we want to keep.
  if (desired.thumbnailId) {
    await tx.mediaImage.updateMany({
      where: { id: desired.thumbnailId, OR: [{ mediaId: null }, { mediaId }] },
      data: { mediaId, kind: "thumbnail", position: 0 },
    });
  }
  const previewIds = desired.previewIds ?? [];
  for (let i = 0; i < previewIds.length; i++) {
    await tx.mediaImage.updateMany({
      where: { id: previewIds[i], OR: [{ mediaId: null }, { mediaId }] },
      data: { mediaId, kind: "preview", position: i },
    });
  }

  // 2. Prune this media's now-unreferenced rows in the reconciled kinds. Runs
  //    before the external-thumbnail insert so that fresh row isn't pruned.
  const survivors = [
    ...(desired.thumbnailId ? [desired.thumbnailId] : []),
    ...previewIds,
  ];
  const kinds: ("thumbnail" | "preview")[] = [];
  if (thumbnailProvided) kinds.push("thumbnail");
  if (previewsProvided) kinds.push("preview");
  await tx.mediaImage.deleteMany({
    where: { mediaId, kind: { in: kinds }, id: { notIn: survivors } },
  });

  // 3. An external thumbnail URL (no upload id) becomes a fresh url-backed row.
  if (thumbnailProvided && !desired.thumbnailId && desired.thumbnailUrl) {
    await tx.mediaImage.create({
      data: { mediaId, kind: "thumbnail", externalUrl: desired.thumbnailUrl, position: 0 },
    });
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

  const products = await prisma.product.findMany({
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

  // Load existing media so we can detect whether the plaintext actually
  // changed (and so we have the current mediaType when source_url changes
  // and we need to rebuild the blob payload).
  const existing = await prisma.media.findUnique({
    where: { id },
    select: { mediaType: true, blob: true, channelId: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const newType: MediaType =
    (validated.media_type as MediaType | undefined) ?? (existing.mediaType as MediaType);

  // Cross-kind media_type changes (url ↔ photo ↔ article) would leave the
  // Media.blob shape mismatched with Media.mediaType — and for envelope kinds
  // they'd orphan or mis-reference the existing EncryptedEnvelope row. Reject
  // them and tell the admin to delete + recreate.
  if (validated.media_type !== undefined && newType !== existing.mediaType) {
    const oldKindClass = kindClassFor(existing.mediaType as MediaType);
    const newKindClass = kindClassFor(newType);
    if (oldKindClass !== newKindClass) {
      return NextResponse.json(
        {
          error: `Cannot change media_type from ${existing.mediaType} to ${newType} via PATCH; delete and recreate the media item`,
        },
        { status: 422 }
      );
    }
  }

  const updates: Prisma.MediaUpdateInput = {};
  if (validated.name !== undefined) updates.name = validated.name;
  if (validated.description !== undefined) updates.description = validated.description;
  if (validated.media_type !== undefined) updates.mediaType = validated.media_type;
  if (validated.position !== undefined) updates.position = validated.position;
  // Thumbnail + preview images live in MediaImage now and are reconciled inside
  // the transaction below (reconcileMediaImages), not via Media columns.

  let plan: UpdatePlan | null = null;
  let existingBlob: MediaBlob | null = null;
  if (validated.source_url !== undefined) {
    existingBlob = (() => {
      try {
        return parseMediaBlob(existing.blob);
      } catch {
        return null;
      }
    })();
    const result = prepareUpdatePlan(validated.source_url, newType, existingBlob);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 422 });
    }
    plan = result;
    if (plan.kind === "url") {
      updates.blob = plan.blob;
    }
    // For "article", `updates.blob` is filled inside the transaction below
    // once the new envelope id is known.
  }

  let media;
  let perProductPlaintext: string | null = null;
  try {
    media = await prisma.$transaction(async (tx) => {
      if (plan?.kind === "article") {
        const envelope = await tx.encryptedEnvelope.create({
          data: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            bytes: plan.envelopeWrite.bytes as any,
            mimeType: plan.envelopeWrite.mimeType,
          },
          select: { id: true },
        });
        updates.blob = {
          kind: "article",
          envelopeId: envelope.id,
          encryptedDek: plan.encryptedDek,
          mimeType: plan.mimeType,
        };
      }
      const updated = await tx.media.update({ where: { id }, data: updates });
      await reconcileMediaImages(tx, id, {
        thumbnailId: validated.thumbnail_id,
        thumbnailUrl: validated.thumbnail_url,
        previewIds: validated.preview_image_ids,
      });
      return updated;
    });
  } catch (err) {
    // Validation already passed; the most likely cause is a concurrent
    // delete or a Prisma RecordNotFound. Map to 404; if it's anything else
    // it'll surface in the server log.
    console.error(`media.PATCH ${id} failed:`, err);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (plan?.kind === "url" && plan.perProductPlaintext !== null) {
    const oldPlaintext = existingBlob?.kind === "url" ? existingBlob.url : null;
    if (oldPlaintext !== plan.perProductPlaintext) {
      perProductPlaintext = plan.perProductPlaintext;
    }
  }

  if (perProductPlaintext !== null) {
    await reEncryptBlobs(media.id, perProductPlaintext);
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

  // Archive corresponding SatsRail products for direct-sale (media-scoped)
  // Product rows. Channel-scoped products are NOT archived — they cover the
  // whole channel; we only delete this media's blob entries (below).
  const directProducts = await prisma.product.findMany({
    where: { mediaId: media.id },
    select: { id: true, satsrailProductId: true },
  });
  const archivedProductIds: string[] = [];
  const archiveErrors: { productId: string; error: string }[] = [];

  if (directProducts.length > 0) {
    const sk = await getMerchantKey();
    if (!sk) {
      console.warn(
        "media.delete: no merchant key — skipping SatsRail archive for products:",
        directProducts.map((p) => p.satsrailProductId)
      );
    } else {
      for (const p of directProducts) {
        try {
          await satsrail.deleteProduct(sk, p.satsrailProductId);
          archivedProductIds.push(p.satsrailProductId);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          console.error(
            `media.delete: failed to archive SatsRail product ${p.satsrailProductId}:`,
            message
          );
          archiveErrors.push({ productId: p.satsrailProductId, error: message });
        }
      }
    }

    // Delete the local Product rows for direct-sale (cascades to blobs).
    await prisma.product.deleteMany({ where: { mediaId: media.id } });
  }

  // Remove this media from any channel-scoped product's blob entries.
  try {
    await prisma.mediaEncryptedBlob.deleteMany({
      where: {
        mediaId: media.id,
        product: { channelId: media.channelId },
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

  // For envelope-encrypted media (photo, article), clean up the
  // EncryptedEnvelope row so we don't leak storage. The bytes are useless
  // without a DEK (which we just deleted along with the Product rows), but
  // they still occupy space.
  if (media.mediaType === "photo" || media.mediaType === "article") {
    try {
      const blob = parseMediaBlob(media.blob);
      if (blob.kind === "photo" || blob.kind === "article") {
        await prisma.encryptedEnvelope.delete({ where: { id: blob.envelopeId } });
      }
    } catch (err) {
      console.error(
        `media.delete: failed to remove encrypted envelope for media ${media.id}:`,
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
