import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMerchantKey } from "@/lib/merchant-key";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { unwrapDekToBase64url } from "@/lib/content-dek";
import { satsrail } from "@/lib/satsrail";
import { parseMediaBlob, plaintextForEncryption } from "@/lib/schemas/media-blob";

/**
 * Create a SatsRail product for a media item and write the media-scoped
 * Product + its single MediaEncryptedBlob row.
 *
 * Flow:
 * 1. Fetch media + channel + merchant key.
 * 2. Create the product on SatsRail with external_ref: md_{media.ref},
 *    using the channel's product type.
 * 3. Fetch the product key.
 * 4. Encrypt the plaintext under the product key with AAD = the SatsRail
 *    product UUID. Plaintext per media kind:
 *      - url media: the URL string
 *      - photo / article: the raw DEK (base64url) — recovered from the
 *        request body for photos (envelope upload returned it) or by
 *        unwrapping Media.blob.encryptedDek with CONTENT_KEK for articles.
 * 5. Write Product + MediaEncryptedBlob in one transaction.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: mediaId } = await params;
  const body = await req.json();

  const {
    name,
    price_cents,
    currency,
    access_duration_seconds,
    image_url,
    dek, // optional — required when mediaType === "photo" (envelope encryption)
  } = body;
  if (!name || !price_cents) {
    return NextResponse.json(
      { error: "name and price_cents are required" },
      { status: 422 }
    );
  }

  const media = await prisma.media.findUnique({ where: { id: mediaId } });
  if (!media) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }

  // For photo media the plaintext we wrap with the product key is the
  // per-photo DEK (envelope encryption), not the photo bytes. The client
  // must supply the DEK from the upload response — we never persist the
  // raw DEK server-side.
  if (media.mediaType === "photo" && !dek) {
    return NextResponse.json(
      { error: "dek is required for photo media" },
      { status: 422 }
    );
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

    // 3. Derive the plaintext to encrypt.
    //    - Photo:   the per-photo DEK the client supplied.
    //    - Article: the per-article DEK, recovered by unwrapping
    //               Media.blob.encryptedDek with CONTENT_KEK.
    //    - URL kinds: the URL string via Media.blob.
    const blob = parseMediaBlob(media.blob);
    let plaintext: string;
    if (media.mediaType === "photo") {
      plaintext = dek as string;
    } else if (blob.kind === "article") {
      plaintext = unwrapDekToBase64url(blob.encryptedDek);
    } else {
      plaintext = plaintextForEncryption(blob);
    }
    const encryptedSource = encryptSourceUrl(plaintext, key, product.id);

    // 4. Write Product + MediaEncryptedBlob atomically.
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
      await tx.mediaEncryptedBlob.create({
        data: {
          productId: productRow.id,
          mediaId,
          encryptedSource,
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
