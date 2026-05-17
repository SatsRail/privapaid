import { notFound } from "next/navigation";
import { connectDB } from "@/lib/mongodb";
import Channel from "@/models/Channel";
import Media from "@/models/Media";
import MediaProduct from "@/models/MediaProduct";
import ChannelProduct from "@/models/ChannelProduct";
import { cookies } from "next/headers";
import config, { getInstanceConfig } from "@/config/instance";
import { COOKIE_NAME, getStoredProductIds } from "@/lib/macaroon-cookie";
import ViewerShell from "@/components/ViewerShell";
import MediaLayout from "@/components/layout/MediaLayout";
import { resolveImageUrl } from "@/lib/images";
import { buildMediaSchema, buildBreadcrumbSchema } from "@/lib/jsonld";
import { auth } from "@/lib/auth";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ slug: string; mediaId: string }>;
  searchParams: Promise<{ preview?: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, mediaId } = await params;
  await connectDB();

  const channel = await Channel.findOne({ slug, active: true })
    .select("name")
    .lean();
  if (!channel) return { title: "Not Found" };

  const media = await Media.findById(mediaId)
    .select("name description media_type thumbnail_url thumbnail_id")
    .lean();
  if (!media) return { title: "Not Found" };

  const instanceConfig = await getInstanceConfig();
  const description = media.description
    ? media.description.slice(0, 160)
    : undefined;
  const imageUrl = media.thumbnail_id
    ? `/api/images/${media.thumbnail_id}`
    : media.thumbnail_url
      || instanceConfig.theme.logo
      || undefined;

  // Map media_type to OG type
  const ogType = media.media_type === "video" ? "video.other"
    : media.media_type === "article" ? "article"
    : media.media_type === "audio" || media.media_type === "podcast" ? "music.song"
    : "website";

  return {
    title: `${media.name} — ${channel.name}`,
    description,
    alternates: { canonical: `/c/${slug}/${mediaId}` },
    openGraph: {
      title: media.name,
      description,
      type: ogType,
      ...(imageUrl && { images: [{ url: imageUrl }] }),
    },
    twitter: {
      card: "summary_large_image",
      title: media.name,
      description,
      ...(imageUrl && { images: [imageUrl] }),
    },
  };
}

export default async function MediaPlayerPage({ params, searchParams }: Props) {
  const { slug, mediaId } = await params;
  const { preview } = await searchParams;
  await connectDB();

  const instanceConfig = await getInstanceConfig();
  const { locale } = instanceConfig;

  const channel = await Channel.findOne({ slug, active: true })
    .lean();
  if (!channel) notFound();
  if (!config.nsfw && channel.nsfw) notFound();

  const media = await Media.findOne({ _id: mediaId, channel_id: channel._id })
    .select("-source_url")
    .lean();
  if (!media) notFound();

  // Get all media products for this media item
  // Filter: $ne "archived" — matches access-gate.ts. Active, inactive, and
  // undefined all pass so a missing status field never hides a product.
  const mediaProducts = await MediaProduct.find({
    media_id: media._id,
    product_status: { $ne: "archived" },
  })
    .select("satsrail_product_id encrypted_source_url key_fingerprint product_name product_price_cents product_currency product_access_duration_seconds product_status")
    .lean();

  // Get channel-level products that cover this media
  const channelProducts = await ChannelProduct.find({
    channel_id: channel._id,
    "encrypted_media.media_id": media._id,
    product_status: { $ne: "archived" },
  })
    .select("satsrail_product_id key_fingerprint encrypted_media product_name product_price_cents product_currency product_access_duration_seconds product_status")
    .lean();

  // Serialize for client — merge media-level and channel-level products
  const products = [
    ...mediaProducts.map((mp) => ({
      productId: mp.satsrail_product_id,
      encryptedBlob: mp.encrypted_source_url,
      keyFingerprint: mp.key_fingerprint,
      name: mp.product_name,
      priceCents: mp.product_price_cents,
      currency: mp.product_currency,
      accessDurationSeconds: mp.product_access_duration_seconds,
      status: mp.product_status,
    })),
    ...channelProducts.flatMap((cp) => {
      const entry = cp.encrypted_media.find(
        (em) => String(em.media_id) === String(media._id)
      );
      if (!entry) return [];
      return [{
        productId: cp.satsrail_product_id,
        encryptedBlob: entry.encrypted_source_url,
        keyFingerprint: cp.key_fingerprint,
        name: cp.product_name,
        priceCents: cp.product_price_cents,
        currency: cp.product_currency,
        accessDurationSeconds: cp.product_access_duration_seconds,
        status: cp.product_status,
      }];
    }),
  ].filter((p) => p.encryptedBlob);

  // Server-side pre-check: which products have stored macaroons?
  const cookieStore = await cookies();
  const storedProductIds = getStoredProductIds(
    cookieStore.get(COOKIE_NAME)?.value,
    products.map((p) => p.productId)
  );

  // Admin preview: validate session server-side
  let adminPreviewSourceUrl: string | null = null;
  if (preview === "admin") {
    try {
      const session = await auth();
      if (session?.user?.type === "admin") {
        const fullMedia = await Media.findById(mediaId)
          .select("source_url")
          .lean();
        adminPreviewSourceUrl = fullMedia?.source_url ?? null;
      }
    } catch {
      // Not authenticated — ignore preview param
    }
  }

  // Resolve preview images and thumbnail
  const previewImages = [
    ...(media.preview_image_ids || []).map((id: string) => `/api/images/${id}`),
    ...(media.preview_image_urls || []),
  ].slice(0, 6);

  const thumbSrc = resolveImageUrl(media.thumbnail_id, media.thumbnail_url);

  // JSON-LD structured data
  const mediaJsonLd = buildMediaSchema(
    {
      _id: String(media._id),
      name: media.name,
      description: media.description,
      media_type: media.media_type,
      thumbnail_url: media.thumbnail_url,
      thumbnail_id: media.thumbnail_id,
      created_at: media.created_at,
      updated_at: media.updated_at,
    },
    { name: channel.name, slug: channel.slug },
    instanceConfig
  );

  const breadcrumbJsonLd = buildBreadcrumbSchema(
    [
      { name: "Home", url: "/" },
      { name: channel.name, url: `/c/${slug}` },
      { name: media.name, url: `/c/${slug}/${mediaId}` },
    ],
    instanceConfig
  );

  // Assemble page data for layout components
  const pageData = {
    media: {
      _id: String(media._id),
      name: media.name,
      description: media.description,
      media_type: media.media_type,
      thumbnail_url: media.thumbnail_url,
      thumbnail_id: media.thumbnail_id,
      views_count: media.views_count,
      comments_count: media.comments_count,
      // For photo media, surface the GridFS pointer to the client so it can
      // fetch the encrypted bytes after unwrapping the DEK.
      photo_gridfs_id: media.media_type === "photo" ? media.source_url : undefined,
    },
    channel: { name: channel.name, slug: channel.slug },
    products,
    storedProductIds,
    previewImages,
    thumbSrc,
    locale,
    instanceConfig: { theme: { logo: instanceConfig.theme.logo }, name: instanceConfig.name },
    adminPreviewSourceUrl,
  };

  return (
    <ViewerShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([mediaJsonLd, breadcrumbJsonLd]) }}
      />
      <MediaLayout {...pageData} />
    </ViewerShell>
  );
}
