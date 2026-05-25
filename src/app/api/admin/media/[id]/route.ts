import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { encryptSourceUrl } from "@/lib/content-encryption";
import {
  parseMediaBlob,
  plaintextForEncryption,
  type MediaBlob,
} from "@/lib/schemas/media-blob";
import type { Prisma } from "@prisma/client";

type MediaType = "video" | "audio" | "article" | "photo" | "podcast";

/**
 * Build the updated blob payload when source_url changes. Photos don't go
 * through this path (their `blob` is set at upload time and shouldn't be
 * rewritten by a PATCH; the photo is identified by its EncryptedPhotoBlob id
 * and cannot be re-aimed at a different blob by an admin edit).
 */
function buildBlobForUpdate(sourceUrl: string, mediaType: MediaType): MediaBlob | null {
  if (mediaType === "photo") return null; // photos: blob is immutable on PATCH
  if (mediaType === "article") return { kind: "markdown", body: sourceUrl };
  return { kind: "url", url: sourceUrl };
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
        data: { encryptedSourceUrl: encrypted },
      });
    }
  } catch (err) {
    console.error("Failed to re-encrypt after source change:", err);
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

  const updates: Prisma.MediaUpdateInput = {};
  if (validated.name !== undefined) updates.name = validated.name;
  if (validated.description !== undefined) updates.description = validated.description;
  if (validated.media_type !== undefined) updates.mediaType = validated.media_type;
  if (validated.thumbnail_url !== undefined) updates.thumbnailUrl = validated.thumbnail_url;
  if (validated.position !== undefined) updates.position = validated.position;

  let plaintextChanged = false;
  if (validated.source_url !== undefined) {
    const newBlob = buildBlobForUpdate(validated.source_url, newType);
    if (newBlob !== null) {
      updates.blob = newBlob;
      const oldPlaintext = (() => {
        try {
          return plaintextForEncryption(parseMediaBlob(existing.blob));
        } catch {
          return null;
        }
      })();
      plaintextChanged = oldPlaintext !== validated.source_url;
    }
  }

  let media;
  try {
    media = await prisma.media.update({ where: { id }, data: updates });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (plaintextChanged && validated.source_url) {
    await reEncryptBlobs(media.id, validated.source_url);
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

  // For photo media, clean up the EncryptedPhotoBlob so we don't leak storage.
  // The bytes are useless without a DEK envelope (which we just deleted along
  // with the Product rows), but they still occupy space.
  if (media.mediaType === "photo") {
    try {
      const blob = parseMediaBlob(media.blob);
      if (blob.kind === "photo") {
        await prisma.encryptedPhotoBlob.delete({ where: { id: blob.blobId } });
      }
    } catch (err) {
      console.error(
        `media.delete: failed to remove encrypted photo blob for media ${media.id}:`,
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
