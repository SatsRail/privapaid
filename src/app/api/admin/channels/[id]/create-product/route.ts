import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMerchantKey } from "@/lib/merchant-key";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { satsrail } from "@/lib/satsrail";
import { dekBase64urlFromEnvelope } from "@/lib/media-envelope";
import { requireAdminApi } from "@/lib/auth-helpers";

/**
 * Create a SatsRail product for a channel and wrap every media's DEK under that
 * product's key.
 *
 * Flow:
 * 1. Fetch channel + all its media (+ envelopes) + merchant key.
 * 2. Create the product on SatsRail with external_ref: ch_{channel.ref},
 *    using the channel's product type.
 * 3. Fetch the product key.
 * 4. For each media: recover the DEK from its MediaEnvelope.wrappedDek (uniform
 *    across kinds) and wrap it under the new product key with AAD = SatsRail
 *    product UUID.
 * 5. Write a channel-scoped Product + one MediaProduct row per media, all in
 *    one transaction.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAdminApi();
  if (authResult instanceof NextResponse) return authResult;

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

    // 3. Wrap every media's DEK under this product's key. The DEK is recovered
    //    from each MediaEnvelope.wrappedDek (CONTENT_KEK, operator-held) — no
    //    SatsRail round-trip needed.
    const mediaItems = await prisma.media.findMany({
      where: { channelId },
      select: { id: true, envelope: { select: { wrappedDek: true } } },
    });

    const encryptedMedia: Array<{ mediaId: string; encryptedDek: string }> = [];
    for (const m of mediaItems) {
      if (!m.envelope) continue; // media with no envelope can't be unlocked; skip
      encryptedMedia.push({
        mediaId: m.id,
        encryptedDek: encryptSourceUrl(
          dekBase64urlFromEnvelope(m.envelope),
          key,
          product.id
        ),
      });
    }

    // 4. Write Product (channel-scoped) + N MediaProduct rows atomically.
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
        mediaProducts: {
          create: encryptedMedia.map((em) => ({
            mediaId: em.mediaId,
            encryptedDek: em.encryptedDek,
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
