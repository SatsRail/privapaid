import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import {
  createEnvelopeArtifacts,
  reencryptEnvelopeBytes,
  URL_ENVELOPE_MIME,
} from "@/lib/media-envelope";
import type { Prisma } from "@prisma/client";

type MediaType = "video" | "audio" | "article" | "photo" | "podcast";
const ARTICLE_MIME = "text/markdown; charset=utf-8";

/**
 * Group MediaTypes by their underlying content shape (url pointer vs envelope
 * bytes). Cross-class changes via PATCH are rejected (see PATCH handler) — they'd
 * leave the encrypted payload mismatched with Media.mediaType.
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

  // Load the current mediaType so we can reject cross-kind changes and pick the
  // envelope MIME when a source_url change re-encrypts the bytes.
  const existing = await prisma.media.findUnique({
    where: { id },
    select: { mediaType: true },
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

  // A source_url change re-encrypts the media's envelope. If an envelope already
  // exists, re-encrypt the bytes under its existing DEK — the DEK, and every
  // MediaProduct row that wraps it, stays valid, so no per-product re-encryption
  // is needed. If the media has NO envelope yet (e.g. a url media not re-imported
  // after the envelope migration), mint a fresh one so updating the URL restores
  // its content. (A media with stale products would then need a re-encrypt to
  // re-wrap the new DEK — but an envelope-less media has no decryptable products
  // to begin with.) Photo bytes are immutable on PATCH (re-upload via
  // /api/admin/photos), so a photo source_url is ignored.
  let envelopeWrite:
    | { mode: "update"; bytes: Buffer }
    | { mode: "create"; bytes: Buffer; wrappedDek: string }
    | null = null;
  if (validated.source_url !== undefined && newType !== "photo") {
    const envelope = await prisma.mediaEnvelope.findUnique({
      where: { mediaId: id },
      select: { wrappedDek: true },
    });
    const payload = Buffer.from(validated.source_url, "utf8");
    try {
      if (envelope) {
        envelopeWrite = { mode: "update", bytes: reencryptEnvelopeBytes(envelope, payload) };
      } else {
        const artifacts = createEnvelopeArtifacts(payload);
        envelopeWrite = {
          mode: "create",
          bytes: artifacts.bytes,
          wrappedDek: artifacts.wrappedDek,
        };
      }
    } catch (err) {
      return NextResponse.json(
        {
          error: `Failed to encrypt envelope: ${err instanceof Error ? err.message : "unknown"}`,
        },
        { status: 422 }
      );
    }
  }

  let media;
  try {
    media = await prisma.$transaction(async (tx) => {
      const updated = await tx.media.update({ where: { id }, data: updates });
      if (envelopeWrite) {
        const mimeType = newType === "article" ? ARTICLE_MIME : URL_ENVELOPE_MIME;
        if (envelopeWrite.mode === "update") {
          await tx.mediaEnvelope.update({
            where: { mediaId: id },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: { bytes: envelopeWrite.bytes as any, mimeType },
          });
        } else {
          await tx.mediaEnvelope.create({
            data: {
              mediaId: id,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              bytes: envelopeWrite.bytes as any,
              mimeType,
              wrappedDek: envelopeWrite.wrappedDek,
            },
          });
        }
      }
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

  // Remove this media from any channel-scoped product's MediaProduct entries
  // (MediaProduct.media is onDelete: Restrict, so these must go before the Media
  // delete below). Direct-sale rows were already cascade-deleted with their Product.
  try {
    await prisma.mediaProduct.deleteMany({
      where: {
        mediaId: media.id,
        product: { channelId: media.channelId },
      },
    });
  } catch (err) {
    console.error("Failed to clean up channel product rows:", err);
  }

  // Decrement channel media count — but only if it wasn't already soft-deleted
  // (legacy state where decrement already happened).
  if (!wasAlreadySoftDeleted) {
    await prisma.channel.update({
      where: { id: media.channelId },
      data: { mediaCount: { decrement: 1 } },
    });
  }

  // Hard-delete the media row. Its one MediaEnvelope is removed automatically
  // via the onDelete: Cascade FK. SatsRail keeps the transaction history; the
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
