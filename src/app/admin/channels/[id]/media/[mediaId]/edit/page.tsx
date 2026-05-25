import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getInstanceConfig } from "@/config/instance";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import MediaForm from "../../MediaForm";
import DeleteMediaButton from "./DeleteMediaButton";

export const dynamic = "force-dynamic";

interface ProductDetail {
  id: string;
  slug: string;
  name: string;
  price_cents: number;
  currency: string;
  status: string;
  external_ref: string | null;
  has_blob: boolean;
  access_duration_seconds: number;
}

interface EncryptedBlobInfo {
  product_id: string;
  scope: "media" | "channel";
  blob_preview: string | null;
  blob_length: number;
  key_fingerprint: string | null;
  created_at: string | null;
}

function blobPreview(blob: string | undefined | null): string | null {
  return blob ? `${blob.slice(0, 24)}...${blob.slice(-8)}` : null;
}

interface MediaProductRow {
  satsrailProductId: string;
  encryptedSourceUrl: string | null;
  keyFingerprint: string | null;
  createdAt: Date;
}

interface ChannelProductRow {
  satsrailProductId: string;
  keyFingerprint: string | null;
  createdAt: Date;
  encryptedMedia: { mediaId: string; encryptedSourceUrl: string | null }[];
}

function buildBlobIdsWithEncryption(
  mediaProducts: MediaProductRow[],
  channelProductDocs: ChannelProductRow[],
  mediaId: string
): { mediaProductIds: Set<string>; channelProductIds: Set<string> } {
  const mediaProductIds = new Set(
    mediaProducts.filter((p) => !!p.encryptedSourceUrl).map((p) => p.satsrailProductId)
  );
  const channelProductIds = new Set(
    channelProductDocs
      .filter((cp) =>
        cp.encryptedMedia.some(
          (em) => em.mediaId === mediaId && !!em.encryptedSourceUrl
        )
      )
      .map((cp) => cp.satsrailProductId)
  );
  return { mediaProductIds, channelProductIds };
}

async function fetchProductDetails(
  sk: string,
  allProductIds: string[],
  blobIds: { mediaProductIds: Set<string>; channelProductIds: Set<string> },
  mediaRef: number | null | undefined
): Promise<ProductDetail[]> {
  const res = await satsrail.listProducts(sk);
  const refPrefix = mediaRef != null ? `md_${mediaRef}` : null;
  const seen = new Set<string>();
  const details: ProductDetail[] = [];

  for (const p of res.data) {
    if (seen.has(p.id) || p.status === "archived") continue;

    const matchesRef = refPrefix && p.external_ref === refPrefix;
    const matchesLocal = allProductIds.includes(p.id);
    if (!matchesRef && !matchesLocal) continue;

    seen.add(p.id);
    details.push({
      id: p.id, slug: p.slug, name: p.name,
      price_cents: p.price_cents, currency: p.currency, status: p.status,
      external_ref: p.external_ref, access_duration_seconds: p.access_duration_seconds,
      has_blob: blobIds.mediaProductIds.has(p.id) || blobIds.channelProductIds.has(p.id),
    });
  }
  return details;
}

function buildEncryptedBlobs(
  mediaProducts: MediaProductRow[],
  channelProductDocs: ChannelProductRow[],
  mediaId: string
): EncryptedBlobInfo[] {
  const blobs: EncryptedBlobInfo[] = [];

  for (const p of mediaProducts) {
    blobs.push({
      product_id: p.satsrailProductId,
      scope: "media",
      blob_preview: blobPreview(p.encryptedSourceUrl),
      blob_length: p.encryptedSourceUrl?.length ?? 0,
      key_fingerprint: p.keyFingerprint || null,
      created_at: p.createdAt ? p.createdAt.toISOString() : null,
    });
  }

  for (const cp of channelProductDocs) {
    const entry = cp.encryptedMedia.find((em) => em.mediaId === mediaId);
    blobs.push({
      product_id: cp.satsrailProductId,
      scope: "channel",
      blob_preview: blobPreview(entry?.encryptedSourceUrl),
      blob_length: entry?.encryptedSourceUrl?.length ?? 0,
      key_fingerprint: cp.keyFingerprint || null,
      created_at: cp.createdAt ? cp.createdAt.toISOString() : null,
    });
  }

  return blobs;
}

export default async function EditMediaPage({
  params,
}: {
  params: Promise<{ id: string; mediaId: string }>;
}) {
  const { id: channelId, mediaId } = await params;

  const [media, channel, instanceConfig] = await Promise.all([
    prisma.media.findUnique({ where: { id: mediaId } }),
    prisma.channel.findUnique({ where: { id: channelId }, select: { slug: true } }),
    getInstanceConfig(),
  ]);
  if (!media) notFound();

  const currency = instanceConfig.currency;

  // MediaProduct is 1:1 with media — use findUnique to fetch, then normalize as array.
  const mediaProductRow = await prisma.mediaProduct.findUnique({
    where: { mediaId },
    select: {
      satsrailProductId: true,
      encryptedSourceUrl: true,
      keyFingerprint: true,
      createdAt: true,
    },
  });
  const mediaProducts: MediaProductRow[] = mediaProductRow ? [mediaProductRow] : [];

  // Channel products that have an encrypted entry for this media.
  const channelProductDocs = await prisma.channelProduct.findMany({
    where: {
      channelId,
      encryptedMedia: { some: { mediaId } },
    },
    select: {
      satsrailProductId: true,
      keyFingerprint: true,
      createdAt: true,
      encryptedMedia: {
        where: { mediaId },
        select: { mediaId: true, encryptedSourceUrl: true },
      },
    },
  });

  const allProductIds = [
    ...mediaProducts.map((p) => p.satsrailProductId),
    ...channelProductDocs.map((p) => p.satsrailProductId),
  ];

  const blobIds = buildBlobIdsWithEncryption(mediaProducts, channelProductDocs, media.id);

  let productDetails: ProductDetail[] = [];
  const sk = await getMerchantKey();
  if (sk) {
    try {
      productDetails = await fetchProductDetails(sk, allProductIds, blobIds, media.ref);
    } catch {
      // SatsRail unreachable — show without product details
    }
  }

  // Preview images: serve via the new bytea-backed route by PreviewImage.id.
  const previewImages = await prisma.previewImage.findMany({
    where: { mediaId: media.id },
    select: { id: true },
    orderBy: { position: "asc" },
  });
  const previewImageIds = previewImages.map((p) => p.id);

  const thumbnailId = media.thumbnailBytes ? media.id : "";

  const serialized = {
    _id: media.id,
    name: media.name,
    description: media.description || "",
    source_url: media.sourceUrl,
    media_type: media.mediaType,
    thumbnail_url: media.thumbnailUrl || "",
    thumbnail_id: thumbnailId,
    preview_image_ids: previewImageIds,
    product_ids: [...new Set([...allProductIds, ...productDetails.map((p) => p.id)])],
  };

  const encryptedBlobs = buildEncryptedBlobs(mediaProducts, channelProductDocs, media.id);

  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <h1 className="text-2xl font-bold">Edit Media</h1>
        {media.ref != null && (
          <span className="rounded bg-[var(--theme-bg-secondary)] border border-[var(--theme-border)] px-2 py-0.5 font-mono text-xs text-[var(--theme-text-secondary)]">
            md_{media.ref}
          </span>
        )}
        <DeleteMediaButton
          mediaId={media.id}
          channelId={channelId}
          name={media.name}
        />
      </div>
      <MediaForm
        channelId={channelId}
        channelSlug={channel?.slug}
        initialData={serialized}
        currency={currency}
        products={productDetails}
        encryptedBlobs={encryptedBlobs}
      />
    </div>
  );
}
