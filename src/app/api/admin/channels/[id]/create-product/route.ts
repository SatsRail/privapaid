import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMerchantKey } from "@/lib/merchant-key";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { unwrapDekToBase64url } from "@/lib/content-dek";
import { satsrail } from "@/lib/satsrail";
import { parseMediaBlob, plaintextForEncryption } from "@/lib/schemas/media-blob";

/**
 * Create a SatsRail product for a channel and encrypt every media in the
 * channel under that product's key.
 *
 * Flow:
 * 1. Fetch channel + all its media + merchant key.
 * 2. Create the product on SatsRail with external_ref: ch_{channel.ref},
 *    using the channel's product type.
 * 3. Fetch the product key.
 * 4. For each media: derive the plaintext (URL for url-backed kinds, raw DEK
 *    for envelope-encrypted kinds) and encrypt under the new product key
 *    with AAD = SatsRail product UUID.
 * 5. Write a channel-scoped Product + one MediaEncryptedBlob row per media,
 *    all in one transaction.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: channelId } = await params;
  const body = await req.json();

  const { name, price_cents, currency, access_duration_seconds, image_url } =
    body;
  if (!name || !price_cents) {
    return NextResponse.json(
      { error: "name and price_cents are required" },
      { status: 422 }
    );
  }

  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  if (!channel.satsrailProductTypeId) {
    return NextResponse.json(
      {
        error:
          "Channel has no SatsRail product type. Re-create the channel or configure it manually.",
      },
      { status: 422 }
    );
  }

  if (channel.ref == null) {
    return NextResponse.json(
      { error: "Channel has no ref assigned" },
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
    // 1. Create product on SatsRail with ch_ external_ref
    const product = await satsrail.createProduct(skLive, {
      name,
      price_cents,
      currency,
      access_duration_seconds,
      image_url,
      product_type_id: channel.satsrailProductTypeId,
      external_ref: `ch_${channel.ref}`,
    });

    // 2. Fetch the encryption key
    const { key, key_fingerprint } = await satsrail.getProductKey(
      skLive,
      product.id
    );

    // 3. Encrypt every media's plaintext under this product's key.
    //    - URL kinds: read the URL straight from Media.blob.
    //    - Envelope kinds (photo, article): unwrap the KEK-protected DEK on
    //      Media.blob.encryptedDek to recover the raw DEK, then wrap under
    //      THIS product's key. No SatsRail round-trip needed for the DEK
    //      since CONTENT_KEK is operator-held.
    const mediaItems = await prisma.media.findMany({
      where: { channelId },
      select: { id: true, blob: true, mediaType: true },
    });

    const encryptedMedia: Array<{ mediaId: string; encryptedSource: string }> = [];
    for (const m of mediaItems) {
      const mediaId = m.id;
      const blob = parseMediaBlob(m.blob);

      const plaintext =
        blob.kind === "photo" || blob.kind === "article"
          ? unwrapDekToBase64url(blob.encryptedDek)
          : plaintextForEncryption(blob);

      encryptedMedia.push({
        mediaId,
        encryptedSource: encryptSourceUrl(plaintext, key, product.id),
      });
    }

    // 4. Write Product (channel-scoped) + N MediaEncryptedBlob rows atomically.
    const channelProduct = await prisma.product.create({
      data: {
        channelId,
        satsrailProductId: product.id,
        keyFingerprint: key_fingerprint,
        productName: product.name,
        productPriceCents: product.price_cents,
        productCurrency: product.currency,
        productAccessDurationSeconds: product.access_duration_seconds,
        productStatus: product.status,
        productSlug: product.slug,
        productExternalRef: product.external_ref ?? `ch_${channel.ref}`,
        syncedAt: new Date(),
        mediaEncryptedBlobs: {
          create: encryptedMedia.map((em) => ({
            mediaId: em.mediaId,
            encryptedSource: em.encryptedSource,
            keyFingerprint: key_fingerprint,
          })),
        },
      },
    });

    return NextResponse.json(
      {
        data: {
          channel_product: {
            id: channelProduct.id,
            satsrail_product_id: product.id,
            encrypted_media_count: encryptedMedia.length,
          },
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
      err instanceof Error ? err.message : "Failed to create channel product";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
