import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMerchantKey } from "@/lib/merchant-key";
import { encryptSourceUrl, decryptSourceUrl } from "@/lib/content-encryption";
import { unwrapDekToBase64url } from "@/lib/photo-dek";
import { satsrail } from "@/lib/satsrail";

/**
 * Create a SatsRail product for a channel and encrypt all media source URLs.
 *
 * Flow:
 * 1. Fetch channel and all its media, get global merchant key
 * 2. Create product on SatsRail with external_ref: ch_{channel.ref}, using channel's product type
 * 3. Fetch the product key from SatsRail
 * 4. Encrypt each media's source URL with the product key
 * 5. Store the ChannelProduct with one ChannelProductMedia per included media
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

    // 3. Encrypt the per-media payload under the new channel product key.
    //    - Non-photo media: encrypt the plaintext sourceUrl.
    //    - Photo media: recover the per-photo DEK and re-wrap it under THIS
    //      product's key. Preferred path is Media.encryptedDek (KEK-wrapped,
    //      no network call). Legacy fallback recovers the DEK by decrypting
    //      an existing MediaProduct.encryptedSourceUrl — kept so photos that
    //      pre-date the encryptedDek field still work until the backfill runs.
    //      Photo bytes never need to be touched either way.
    const mediaItems = await prisma.media.findMany({
      where: { channelId },
      select: { id: true, sourceUrl: true, mediaType: true, encryptedDek: true },
    });

    const encryptedMedia: Array<{ mediaId: string; encryptedSourceUrl: string }> = [];
    for (const m of mediaItems) {
      const mediaId = m.id;
      if (m.mediaType === "photo") {
        let dekBase64url: string | null = null;

        // Preferred: unwrap the KEK-protected DEK stored on Media.
        if (m.encryptedDek) {
          try {
            dekBase64url = unwrapDekToBase64url(m.encryptedDek);
          } catch (err) {
            console.error(
              `Failed to unwrap encryptedDek for photo ${mediaId}, falling back to MediaProduct recovery:`,
              err
            );
          }
        }

        // Legacy fallback: recover the DEK from an existing MediaProduct.
        if (!dekBase64url) {
          const existing = await prisma.mediaProduct.findUnique({ where: { mediaId } });
          if (!existing) {
            return NextResponse.json(
              {
                error: `Cannot include photo media ${mediaId} in channel product: no encrypted_dek on Media and no existing MediaProduct to recover from. Run the photo-DEK backfill, or create a per-media product for this photo first.`,
              },
              { status: 422 }
            );
          }
          const { key: otherKey } = await satsrail.getProductKey(
            skLive,
            existing.satsrailProductId
          );
          dekBase64url = decryptSourceUrl(
            existing.encryptedSourceUrl,
            otherKey,
            existing.satsrailProductId
          );
        }

        encryptedMedia.push({
          mediaId,
          encryptedSourceUrl: encryptSourceUrl(dekBase64url, key, product.id),
        });
        continue;
      }
      encryptedMedia.push({
        mediaId,
        encryptedSourceUrl: encryptSourceUrl(m.sourceUrl, key, product.id),
      });
    }

    // 4. Store the ChannelProduct with cached metadata
    const channelProduct = await prisma.channelProduct.create({
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
        encryptedMedia: {
          create: encryptedMedia.map((em) => ({
            mediaId: em.mediaId,
            encryptedSourceUrl: em.encryptedSourceUrl,
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
