import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import Media from "@/models/Media";
import MediaProduct from "@/models/MediaProduct";
import ChannelProduct from "@/models/ChannelProduct";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { getEncryptedPhotosBucket } from "@/lib/gridfs";
import { ObjectId } from "mongodb";

async function reEncryptBlobs(
  mediaDocId: string,
  channelId: string,
  mediaObjectId: string,
  newSourceUrl: string
): Promise<void> {
  try {
    const sk = await getMerchantKey();
    if (!sk) return;

    const mediaProducts = await MediaProduct.find({ media_id: mediaDocId });
    for (const mp of mediaProducts) {
      const { key } = await satsrail.getProductKey(sk, mp.satsrail_product_id);
      const encrypted = encryptSourceUrl(newSourceUrl, key, mp.satsrail_product_id);
      await MediaProduct.updateOne({ _id: mp._id }, { encrypted_source_url: encrypted });
    }

    const channelProducts = await ChannelProduct.find({
      channel_id: channelId,
      "encrypted_media.media_id": mediaObjectId,
    });
    for (const cp of channelProducts) {
      const { key } = await satsrail.getProductKey(sk, cp.satsrail_product_id);
      const encrypted = encryptSourceUrl(newSourceUrl, key, cp.satsrail_product_id);
      await ChannelProduct.updateOne(
        { _id: cp._id, "encrypted_media.media_id": mediaObjectId },
        { $set: { "encrypted_media.$.encrypted_source_url": encrypted } }
      );
    }
  } catch (err) {
    console.error("Failed to re-encrypt after source_url change:", err);
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;
  await connectDB();
  const { id } = await params;
  const media = await Media.findById(id).lean();
  if (!media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const products = await MediaProduct.find({ media_id: id })
    .select("satsrail_product_id created_at")
    .lean();

  return NextResponse.json({
    data: {
      ...media,
      product_ids: products.map((p) => p.satsrail_product_id),
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

  await connectDB();
  const { id } = await params;

  const updates: Record<string, unknown> = {};
  const fields = [
    "name", "description", "source_url", "media_type", "thumbnail_url", "thumbnail_id", "preview_image_ids", "position",
  ] as const;
  for (const field of fields) {
    if (validated[field] !== undefined) updates[field] = validated[field];
  }

  const oldMedia = validated.source_url !== undefined
    ? await Media.findById(id).select("source_url").lean()
    : null;

  const media = await Media.findByIdAndUpdate(id, updates, {
    returnDocument: "after",
  }).lean();
  if (!media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Re-encrypt blobs if source_url changed
  if (oldMedia && validated.source_url && validated.source_url !== oldMedia.source_url) {
    await reEncryptBlobs(id, String(media.channel_id), String(media._id), validated.source_url);
  }

  return NextResponse.json({ data: media });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;
  await connectDB();
  const { id } = await params;

  const media = await Media.findById(id);
  if (!media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const wasAlreadySoftDeleted = media.deleted_at !== null;

  // Archive corresponding SatsRail products for individual MediaProducts.
  // ChannelProducts are NOT archived — they cover the whole channel; we only
  // pull this media's entry from their encrypted_media array (below).
  const mediaProducts = await MediaProduct.find({ media_id: media._id })
    .select("satsrail_product_id")
    .lean();
  const archivedProductIds: string[] = [];
  const archiveErrors: { productId: string; error: string }[] = [];

  if (mediaProducts.length > 0) {
    const sk = await getMerchantKey();
    if (!sk) {
      console.warn(
        "media.delete: no merchant key — skipping SatsRail archive for products:",
        mediaProducts.map((mp) => mp.satsrail_product_id)
      );
    } else {
      for (const mp of mediaProducts) {
        try {
          await satsrail.deleteProduct(sk, mp.satsrail_product_id);
          archivedProductIds.push(mp.satsrail_product_id);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          console.error(
            `media.delete: failed to archive SatsRail product ${mp.satsrail_product_id}:`,
            message
          );
          archiveErrors.push({ productId: mp.satsrail_product_id, error: message });
        }
      }
    }

    await MediaProduct.deleteMany({ media_id: media._id });
  }

  // Remove this media from channel product encrypted_media arrays.
  try {
    await ChannelProduct.updateMany(
      { channel_id: media.channel_id },
      { $pull: { encrypted_media: { media_id: media._id } } }
    );
  } catch (err) {
    console.error("Failed to clean up channel product blobs:", err);
  }

  // Decrement channel media count — but only if it wasn't already soft-deleted
  // (legacy state where decrement already happened).
  if (!wasAlreadySoftDeleted) {
    const { default: Channel } = await import("@/models/Channel");
    await Channel.findByIdAndUpdate(media.channel_id, {
      $inc: { media_count: -1 },
    });
  }

  // For photo media, clean up the encrypted GridFS file so we don't leak
  // storage. The bytes are useless without a DEK envelope (which we just
  // deleted along with MediaProduct), but they still occupy space.
  if (media.media_type === "photo" && media.source_url) {
    try {
      if (ObjectId.isValid(media.source_url)) {
        const bucket = await getEncryptedPhotosBucket();
        await bucket.delete(new ObjectId(media.source_url));
      }
    } catch (err) {
      console.error(
        `media.delete: failed to remove encrypted photo bytes ${media.source_url}:`,
        err
      );
      // Continue — orphaned bytes are a soft failure, not a blocking one
    }
  }

  // Hard-delete the media row. SatsRail keeps the transaction history; the
  // audit log below records the deletion event independently of the row.
  await Media.deleteOne({ _id: media._id });

  audit({
    actorId: auth.id,
    actorEmail: auth.email,
    actorType: "admin",
    action: "media.delete",
    targetType: "media",
    targetId: id,
    details: {
      name: media.name,
      channel_id: String(media.channel_id),
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
