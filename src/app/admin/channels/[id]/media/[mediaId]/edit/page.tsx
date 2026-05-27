import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getInstanceConfig } from "@/config/instance";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import MediaForm from "../../MediaForm";
import DeleteMediaButton from "./DeleteMediaButton";
import { parseMediaBlob } from "@/lib/schemas/media-blob";
import { decryptBytes } from "@/lib/content-encryption";
import { unwrapDek } from "@/lib/content-dek";

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

interface BlobWithProduct {
  encryptedSource: string;
  keyFingerprint: string | null;
  createdAt: Date;
  product: {
    satsrailProductId: string;
    keyFingerprint: string | null;
    channelId: string | null;
    mediaId: string | null;
  };
}

async function fetchProductDetails(
  sk: string,
  allProductIds: string[],
  productIdsWithBlob: Set<string>,
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
      id: p.id,
      slug: p.slug,
      name: p.name,
      price_cents: p.price_cents,
      currency: p.currency,
      status: p.status,
      external_ref: p.external_ref,
      access_duration_seconds: p.access_duration_seconds,
      has_blob: productIdsWithBlob.has(p.id),
    });
  }
  return details;
}

function buildEncryptedBlobs(blobs: BlobWithProduct[]): EncryptedBlobInfo[] {
  return blobs.map((b) => ({
    product_id: b.product.satsrailProductId,
    scope: b.product.mediaId ? ("media" as const) : ("channel" as const),
    blob_preview: blobPreview(b.encryptedSource),
    blob_length: b.encryptedSource?.length ?? 0,
    key_fingerprint: b.keyFingerprint ?? b.product.keyFingerprint ?? null,
    created_at: b.createdAt ? b.createdAt.toISOString() : null,
  }));
}

/**
 * Recover the on-the-wire `source_url` value for the form from Media.blob.
 * Articles are envelope-encrypted at rest, so we decrypt on the fly using
 * CONTENT_KEK + the envelope bytes; the form expects raw markdown.
 *
 * On any decryption / row-missing failure throws — the edit page surfaces
 * that as a 500 rather than silently rendering an empty form (which would
 * have the admin save an empty article on submit).
 */
async function sourceUrlForForm(blob: unknown): Promise<string> {
  const parsed = parseMediaBlob(blob);
  if (parsed.kind === "url") return parsed.url;
  if (parsed.kind === "photo") return parsed.envelopeId;
  // article
  const envelope = await prisma.encryptedEnvelope.findUnique({
    where: { id: parsed.envelopeId },
    select: { bytes: true },
  });
  if (!envelope) {
    throw new Error(
      `Article envelope ${parsed.envelopeId} missing — content unrecoverable`
    );
  }
  const dek = unwrapDek(parsed.encryptedDek);
  return decryptBytes(envelope.bytes as Buffer, dek).toString("utf8");
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

  // All blobs covering this media (direct-sale + channel-scoped), via the
  // unified MediaEncryptedBlob table.
  const blobs = await prisma.mediaEncryptedBlob.findMany({
    where: { mediaId },
    select: {
      encryptedSource: true,
      keyFingerprint: true,
      createdAt: true,
      product: {
        select: {
          satsrailProductId: true,
          keyFingerprint: true,
          channelId: true,
          mediaId: true,
        },
      },
    },
  });

  const allProductIds = Array.from(
    new Set(blobs.map((b) => b.product.satsrailProductId))
  );
  const productIdsWithBlob = new Set(
    blobs.filter((b) => !!b.encryptedSource).map((b) => b.product.satsrailProductId)
  );

  let productDetails: ProductDetail[] = [];
  const sk = await getMerchantKey();
  if (sk) {
    try {
      productDetails = await fetchProductDetails(sk, allProductIds, productIdsWithBlob, media.ref);
    } catch {
      // SatsRail unreachable — show without product details
    }
  }

  // Extract blob ids from Media.previewImageUrls (shaped like `/api/images/<id>`).
  // External URLs (non-/api/images/) pass through unchanged in display but
  // don't surface as removable "ids" in the admin slot UI.
  const previewImageIds = (media.previewImageUrls ?? [])
    .map((u) => {
      const m = /^\/api\/images\/([^/?#]+)$/.exec(u);
      return m ? m[1] : null;
    })
    .filter((id): id is string => id !== null);

  const thumbnailId = media.thumbnailBytes ? media.id : "";

  const serialized = {
    _id: media.id,
    name: media.name,
    description: media.description || "",
    source_url: await sourceUrlForForm(media.blob),
    media_type: media.mediaType,
    thumbnail_url: media.thumbnailUrl || "",
    thumbnail_id: thumbnailId,
    preview_image_ids: previewImageIds,
    product_ids: [...new Set([...allProductIds, ...productDetails.map((p) => p.id)])],
  };

  const encryptedBlobs = buildEncryptedBlobs(blobs);

  return (
    <div>
      <DeleteMediaButton mediaId={mediaId} name={media.name} channelId={channelId} />
      <MediaForm
        channelId={channelId}
        channelSlug={channel?.slug}
        currency={currency}
        initialData={serialized}
        products={productDetails}
        encryptedBlobs={encryptedBlobs}
      />
    </div>
  );
}
