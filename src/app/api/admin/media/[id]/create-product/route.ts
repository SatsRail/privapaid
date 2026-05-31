import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMerchantKey } from "@/lib/merchant-key";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { satsrail } from "@/lib/satsrail";
import { dekBase64urlFromEnvelope } from "@/lib/media-envelope";
import { requireAdminApi } from "@/lib/auth-helpers";

/**
 * Create a SatsRail product for a media item and write the media-scoped
 * Product + its single MediaProduct row.
 *
 * Flow:
 * 1. Fetch media (+ its envelope) + channel + merchant key.
 * 2. Create the product on SatsRail with external_ref: md_{media.ref},
 *    using the channel's product type.
 * 3. Fetch the product key.
 * 4. Wrap the media DEK (recovered from MediaEnvelope.wrappedDek, uniform across
 *    all media kinds) under the product key with AAD = the SatsRail product UUID.
 * 5. Write Product + MediaProduct in one transaction.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAdminApi();
  if (authResult instanceof NextResponse) return authResult;

  const { id: mediaId } = await params;
  const body = await req.json();

  const {
    name,
    price_cents,
    currency,
    access_duration_seconds,
    image_url,
  } = body;
  if (!name || !price_cents) {
    return NextResponse.json(
      { error: "name and price_cents are required" },
      { status: 422 }
    );
  }

  const media = await prisma.media.findUnique({
    where: { id: mediaId },
    include: { envelope: { select: { wrappedDek: true } } },
  });
  if (!media) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }
  if (!media.envelope) {
    return NextResponse.json({ error: "Media has no envelope" }, { status: 422 });
  }

  const channel = await prisma.channel.findUnique({
    where: { id: media.channelId },
  });
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 422 });
  }

  if (!channel.satsrailProductTypeId) {
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
    // 1. Create product on SatsRail with channel's product type + md_ external_ref
    const product = await satsrail.createProduct(skLive, {
      name,
      price_cents,
      currency,
      access_duration_seconds,
      image_url,
      product_type_id: channel.satsrailProductTypeId,
      external_ref: `md_${media.ref}`,
    });

    // 2. Fetch the encryption key (includes SHA-256 fingerprint for verification)
    const { key, key_fingerprint } = await satsrail.getProductKey(skLive, product.id);

    // 3. The product-key plaintext is the media DEK, recovered from the
    //    envelope's CONTENT_KEK-wrapped copy — uniform across all media kinds.
    const plaintext = dekBase64urlFromEnvelope(media.envelope);
    const encryptedDek = encryptSourceUrl(plaintext, key, product.id);

    // 4. Write Product + MediaProduct atomically.
    const result = await prisma.$transaction(async (tx) => {
      const productRow = await tx.product.create({
        data: {
          satsrailProductId: product.id,
          mediaId,
          keyFingerprint: key_fingerprint,
          productName: product.name,
          productPriceCents: product.price_cents,
          productCurrency: product.currency,
          productAccessDurationSeconds: product.access_duration_seconds,
          productStatus: product.status,
          productSlug: product.slug,
          productExternalRef: product.external_ref ?? `md_${media.ref}`,
          syncedAt: new Date(),
        },
      });
      await tx.mediaProduct.create({
        data: {
          productId: productRow.id,
          mediaId,
          encryptedDek,
          keyFingerprint: key_fingerprint,
        },
      });
      return productRow;
    });

    return NextResponse.json(
      {
        data: {
          media_product: result,
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
