import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import Media from "@/models/Media";
import Channel from "@/models/Channel";
import MediaProduct from "@/models/MediaProduct";
import ChannelProduct from "@/models/ChannelProduct";
import { getNextRef } from "@/models/Counter";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { encryptSourceUrl } from "@/lib/content-encryption";

export async function GET(req: NextRequest) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;
  await connectDB();
  const { searchParams } = new URL(req.url);
  const channelId = searchParams.get("channel_id");

  if (!channelId) {
    return NextResponse.json(
      { error: "channel_id is required" },
      { status: 422 }
    );
  }

  const mediaItems = await Media.find({ channel_id: channelId, deleted_at: null })
    .sort({ position: 1 })
    .lean();

  // Attach product IDs to each media item
  const mediaIds = mediaItems.map((m) => m._id);
  const mediaProducts = await MediaProduct.find({
    media_id: { $in: mediaIds },
  })
    .select("media_id satsrail_product_id")
    .lean();

  const productMap = new Map<string, string[]>();
  for (const mp of mediaProducts) {
    const key = String(mp.media_id);
    if (!productMap.has(key)) productMap.set(key, []);
    productMap.get(key)!.push(mp.satsrail_product_id);
  }

  const data = mediaItems.map((m) => ({
    ...m,
    product_ids: productMap.get(String(m._id)) || [],
  }));

  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;
  const result = await validateBody(req, schemas.mediaCreate);
  if (isValidationError(result)) return result;

  await connectDB();

  const { channel_id, name, source_url, media_type, dek } = result;

  const channel = await Channel.findById(channel_id);
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  // For photo media added to a channel with existing ChannelProducts, we MUST
  // have the DEK in hand to wrap it under each product key — there's no other
  // way to recover the per-photo DEK on the server.
  if (media_type === "photo") {
    const existingChannelProducts = await ChannelProduct.countDocuments({ channel_id });
    if (existingChannelProducts > 0 && !dek) {
      return NextResponse.json(
        { error: "dek is required for photo media when the channel already has products" },
        { status: 422 }
      );
    }
  }

  // Auto-set position
  const maxPos = await Media.findOne({ channel_id })
    .sort({ position: -1 })
    .select("position")
    .lean();

  const ref = await getNextRef("media");

  const media = await Media.create({
    ref,
    channel_id,
    name: name.trim(),
    description: result.description || "",
    source_url,
    media_type: media_type || "video",
    thumbnail_url: result.thumbnail_url || "",
    thumbnail_id: result.thumbnail_id || "",
    position: result.position ?? (maxPos?.position ?? 0) + 1,
    comments_count: 0,
    flags_count: 0,
  });

  audit({
    actorId: auth.id,
    actorEmail: auth.email,
    actorType: "admin",
    action: "media.create",
    targetType: "media",
    targetId: String(media._id),
    details: { name: media.name, channel_id },
  });

  // Increment channel media count
  await Channel.findByIdAndUpdate(channel_id, { $inc: { media_count: 1 } });

  // Encrypt for existing channel products
  try {
    const channelProductDocs = await ChannelProduct.find({ channel_id });
    if (channelProductDocs.length > 0) {
      const sk = await getMerchantKey();
      if (sk) {
        for (const cp of channelProductDocs) {
          const { key } = await satsrail.getProductKey(
            sk,
            cp.satsrail_product_id
          );
          // For photo media (envelope encryption), wrap the per-photo DEK
          // rather than the source_url (which is just a GridFS pointer).
          const plaintext = media_type === "photo" ? (dek as string) : source_url;
          const encrypted_source_url = encryptSourceUrl(plaintext, key, cp.satsrail_product_id);
          await ChannelProduct.updateOne(
            { _id: cp._id },
            {
              $push: {
                encrypted_media: {
                  media_id: media._id,
                  encrypted_source_url,
                },
              },
            }
          );
        }
      }
    }
  } catch (err) {
    // Media creation succeeds even if channel product encryption fails
    console.error("Failed to encrypt for channel products:", err);
  }

  return NextResponse.json({ data: media }, { status: 201 });
}
