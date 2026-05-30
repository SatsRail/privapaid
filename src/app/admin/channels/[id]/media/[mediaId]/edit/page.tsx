import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getInstanceConfig } from "@/config/instance";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import MediaForm from "../../MediaForm";
import DeleteMediaButton from "./DeleteMediaButton";
import MarkResolvedButton from "./MarkResolvedButton";
import Badge from "@/components/ui/Badge";
import { t } from "@/i18n";
import { decryptEnvelopePayload } from "@/lib/media-envelope";

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
  encryptedDek: string;
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
    blob_preview: blobPreview(b.encryptedDek),
    blob_length: b.encryptedDek?.length ?? 0,
    key_fingerprint: b.keyFingerprint ?? b.product.keyFingerprint ?? null,
    created_at: b.createdAt ? b.createdAt.toISOString() : null,
  }));
}

/**
 * Recover the on-the-wire `source_url` value for the form by decrypting the
 * media's envelope (CONTENT_KEK). url → the URL, article → the markdown body,
 * photo → the envelope id pointer.
 *
 * Throws on any decryption / row-missing failure — the edit page surfaces that
 * as a 500 rather than silently rendering an empty form (which would have the
 * admin save empty content on submit).
 */
async function sourceUrlForForm(media: {
  mediaType: string;
  envelope: { id: string; bytes: Uint8Array; wrappedDek: string | null } | null;
}): Promise<string> {
  if (!media.envelope) {
    throw new Error("Media envelope missing — content unrecoverable");
  }
  if (media.mediaType === "photo") return media.envelope.id;
  return decryptEnvelopePayload(media.envelope).toString("utf8");
}

export default async function EditMediaPage({
  params,
}: {
  params: Promise<{ id: string; mediaId: string }>;
}) {
  const { id: channelId, mediaId } = await params;

  const [media, channel, instanceConfig] = await Promise.all([
    prisma.media.findUnique({
      where: { id: mediaId },
      include: {
        images: {
          select: { id: true, kind: true, externalUrl: true, position: true },
        },
        envelope: { select: { id: true, bytes: true, wrappedDek: true } },
      },
    }),
    prisma.channel.findUnique({ where: { id: channelId }, select: { slug: true } }),
    getInstanceConfig(),
  ]);
  if (!media) notFound();

  const currency = instanceConfig.currency;
  const locale = instanceConfig.locale;

  // All product rows covering this media (direct-sale + channel-scoped), via
  // the unified MediaProduct table.
  const blobs = await prisma.mediaProduct.findMany({
    where: { mediaId },
    select: {
      encryptedDek: true,
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
    blobs.filter((b) => !!b.encryptedDek).map((b) => b.product.satsrailProductId)
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

  // Map the MediaImage relation into the form's wire shape. The form round-trips
  // byte-backed images by id (/api/images/<id>) and a url-backed thumbnail via
  // thumbnail_url. Byte-backed previews surface as removable id slots; url-backed
  // previews (imported) aren't editable in the slot UI and drop on save.
  const thumbnailRow = media.images.find((img) => img.kind === "thumbnail");
  const thumbnailId = thumbnailRow && !thumbnailRow.externalUrl ? thumbnailRow.id : "";
  const thumbnailUrl = thumbnailRow?.externalUrl ?? "";
  const previewImageIds = media.images
    .filter((img) => img.kind === "preview" && !img.externalUrl)
    .sort((a, b) => a.position - b.position)
    .map((img) => img.id);

  const serialized = {
    _id: media.id,
    name: media.name,
    description: media.description || "",
    source_url: await sourceUrlForForm(media),
    media_type: media.mediaType,
    thumbnail_url: thumbnailUrl,
    thumbnail_id: thumbnailId,
    preview_image_ids: previewImageIds,
    product_ids: [...new Set([...allProductIds, ...productDetails.map((p) => p.id)])],
  };

  const encryptedBlobs = buildEncryptedBlobs(blobs);

  return (
    <div>
      {media.status === "error" && (
        <div className="mb-6 rounded-xl border border-red-900/50 bg-red-950/20 p-5">
          <div className="flex items-center gap-2">
            <Badge color="red">{t(locale, "admin.media.status_error_badge")}</Badge>
            <h2 className="text-sm font-semibold text-red-300">
              {t(locale, "admin.media.status_error_title")}
            </h2>
          </div>
          <p className="mt-2 text-sm text-[var(--theme-text-secondary)]">
            {t(locale, "admin.media.status_error_description")}
          </p>
          <dl className="mt-3 space-y-1 text-sm">
            {media.statusReason && (
              <div className="flex gap-2">
                <dt className="text-[var(--theme-text-secondary)]">
                  {t(locale, "admin.media.status_reason")}:
                </dt>
                <dd>{t(locale, `admin.media.reason_${media.statusReason}`)}</dd>
              </div>
            )}
            {media.statusChangedAt && (
              <div className="flex gap-2">
                <dt className="text-[var(--theme-text-secondary)]">
                  {t(locale, "admin.media.status_flagged_at")}:
                </dt>
                <dd>{media.statusChangedAt.toISOString().replace("T", " ").slice(0, 19)} UTC</dd>
              </div>
            )}
          </dl>
          <MarkResolvedButton mediaId={mediaId} />
        </div>
      )}
      <MediaForm
        channelId={channelId}
        channelSlug={channel?.slug}
        currency={currency}
        initialData={serialized}
        products={productDetails}
        encryptedBlobs={encryptedBlobs}
      />
      <div className="mt-10">
        <DeleteMediaButton mediaId={mediaId} name={media.name} channelId={channelId} />
      </div>
    </div>
  );
}
