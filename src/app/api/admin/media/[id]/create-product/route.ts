import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import Media from "@/models/Media";
import Channel from "@/models/Channel";
import MediaProduct from "@/models/MediaProduct";
import { getMerchantKey } from "@/lib/merchant-key";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { satsrail } from "@/lib/satsrail";

/**
 * Create a SatsRail product for a media item and encrypt its source URL.
 *
 * Flow:
 * 1. Fetch media and channel, get global merchant key
 * 2. Create product on SatsRail with external_ref: md_{media.ref}, using channel's product type
 * 3. Fetch the product key from SatsRail
 * 4. Encrypt the source URL with the product key
 * 5. Store the MediaProduct with the encrypted blob
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await connectDB();
  const { id: mediaId } = await params;
  const body = await req.json();

  const {
    name,
    price_cents,
    currency,
    access_duration_seconds,
    image_url,
    dek, // optional — required when media_type === "photo" (envelope encryption)
  } = body;
  if (!name || !price_cents) {
    return NextResponse.json(
      { error: "name and price_cents are required" },
      { status: 422 }
    );
  }

  // 1. Fetch media, channel, and merchant key
  const media = await Media.findById(mediaId);
  if (!media) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }

  // Photo media uses envelope encryption: the plaintext we wrap with the
  // product key is the per-photo DEK, not the source_url. The client must
  // supply the DEK from the upload response — we never persist it server-side.
  if (media.media_type === "photo" && !dek) {
    return NextResponse.json(
      { error: "dek is required for photo media" },
      { status: 422 }
    );
  }

  const channel = await Channel.findById(media.channel_id);
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 422 });
  }

  if (!channel.satsrail_product_type_id) {
    return NextResponse.json(
      { error: "Channel has no SatsRail product type. Re-create the channel or configure it manually." },
      { status: 422 }
    );
  }

  const skLive = await getMerchantKey();
  if (!skLive) {
    return NextResponse.json(
      { error: "Merchant API key not configured" },
      { status: 422 }
    );
  }

  try {
    // 2. Create product on SatsRail with channel's product type and md_ external_ref
    const product = await satsrail.createProduct(skLive, {
      name,
      price_cents,
      currency,
      access_duration_seconds,
      image_url,
      product_type_id: channel.satsrail_product_type_id,
      external_ref: `md_${media.ref}`,
    });

    // 3. Fetch the encryption key (includes SHA-256 fingerprint for verification)
    const { key, key_fingerprint } = await satsrail.getProductKey(skLive, product.id);

    // 4. Encrypt the content payload
    //    - For photo media: wrap the per-photo DEK (envelope encryption).
    //      `media.source_url` holds the GridFS pointer to the ciphertext.
    //    - For everything else: encrypt the source_url itself.
    const plaintext = media.media_type === "photo" ? (dek as string) : media.source_url;
    const encryptedSourceUrl = encryptSourceUrl(plaintext, key, product.id);

    // 5. Create MediaProduct with key fingerprint and cached metadata
    const mediaProduct = await MediaProduct.create({
      media_id: mediaId,
      satsrail_product_id: product.id,
      encrypted_source_url: encryptedSourceUrl,
      key_fingerprint,
      product_name: product.name,
      product_price_cents: product.price_cents,
      product_currency: product.currency,
      product_access_duration_seconds: product.access_duration_seconds,
      product_status: product.status,
      product_slug: product.slug,
      product_external_ref: product.external_ref ?? `md_${media.ref}`,
      synced_at: new Date(),
    });

    return NextResponse.json(
      {
        data: {
          media_product: mediaProduct,
          product: {
            id: product.id,
            name: product.name,
            price_cents: product.price_cents,
            slug: product.slug,
          },
        },
      },
      { status: 201 }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create product";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
