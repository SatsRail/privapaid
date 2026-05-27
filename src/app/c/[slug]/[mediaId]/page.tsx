import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { cookies } from "next/headers";
import config, { getInstanceConfig } from "@/config/instance";
import { COOKIE_NAME, getStoredProductIds } from "@/lib/macaroon-cookie";
import ViewerShell from "@/components/ViewerShell";
import MediaLayout from "@/components/layout/MediaLayout";
import { buildMediaSchema, buildBreadcrumbSchema } from "@/lib/jsonld";
import { auth } from "@/lib/auth";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ slug: string; mediaId: string }>;
  searchParams: Promise<{ preview?: string }>;
}

function resolveChannelAvatar(channel: {
  id: string;
  profileImageBytes: Uint8Array | null;
  profileImageUrl: string;
}): string {
  if (channel.profileImageBytes) return `/api/images/channel/${channel.id}`;
  return channel.profileImageUrl || "";
}

function resolveMediaThumb(media: {
  id: string;
  thumbnailBytes: Uint8Array | null;
  thumbnailUrl: string;
}): string {
  if (media.thumbnailBytes) return `/api/images/media-thumbnail/${media.id}`;
  return media.thumbnailUrl || "";
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, mediaId } = await params;

  const channel = await prisma.channel.findFirst({
    where: { slug, active: true },
    select: { id: true, name: true },
  });
  if (!channel) return { title: "Not Found" };

  const media = await prisma.media.findUnique({
    where: { id: mediaId },
    select: {
      id: true,
      name: true,
      description: true,
      mediaType: true,
      thumbnailUrl: true,
      thumbnailBytes: true,
    },
  });
  if (!media) return { title: "Not Found" };

  const instanceConfig = await getInstanceConfig();
  const description = media.description
    ? media.description.slice(0, 160)
    : undefined;
  const imageUrl = media.thumbnailBytes
    ? `/api/images/media-thumbnail/${media.id}`
    : media.thumbnailUrl
      || instanceConfig.theme.logo
      || undefined;

  // Map media_type to OG type
  const ogType = media.mediaType === "video" ? "video.other"
    : media.mediaType === "article" ? "article"
    : media.mediaType === "audio" || media.mediaType === "podcast" ? "music.song"
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

  const instanceConfig = await getInstanceConfig();
  const { locale } = instanceConfig;

  const channel = await prisma.channel.findFirst({
    where: { slug, active: true },
  });
  if (!channel) notFound();
  if (!config.nsfw && channel.nsfw) notFound();

  // We fetch the full Media row (including `blob`) because for envelope-
  // encrypted media (photo, article) we need blob.envelopeId to surface as
  // `envelope_id` on the client (it points to EncryptedEnvelope and is safe
  // to expose — bytes are useless without the DEK). For url-backed media,
  // `blob` holds the plaintext URL which we DO NOT surface; the page
  // payload is filtered explicitly below.
  const media = await prisma.media.findFirst({
    where: { id: mediaId, channelId: channel.id },
  });
  if (!media) notFound();

  // Every product (active + archived) that covers this media — channel-scoped
  // and media-scoped collapse into the same shape via MediaEncryptedBlob.
  // Archived products must still be verifiable for users who already paid
  // (archiving means "stop selling new", not "revoke existing access"). We
  // filter archived OUT below, only for the purchase UI.
  const productBlobs = await prisma.mediaEncryptedBlob.findMany({
    where: { mediaId: media.id },
    select: {
      encryptedSource: true,
      keyFingerprint: true,
      product: {
        select: {
          satsrailProductId: true,
          keyFingerprint: true,
          productName: true,
          productPriceCents: true,
          productCurrency: true,
          productAccessDurationSeconds: true,
          productStatus: true,
        },
      },
    },
  });

  const allProducts = productBlobs
    .filter((b) => b.encryptedSource)
    .map((b) => ({
      productId: b.product.satsrailProductId,
      encryptedBlob: b.encryptedSource,
      keyFingerprint: b.keyFingerprint ?? b.product.keyFingerprint,
      name: b.product.productName,
      priceCents: b.product.productPriceCents,
      currency: b.product.productCurrency,
      accessDurationSeconds: b.product.productAccessDurationSeconds,
      status: b.product.productStatus,
    }));

  // Purchase-UI list — what PaymentWall renders as buy buttons. Archived
  // products are hidden here so the merchant's "stop selling" decision is
  // honored client-side.
  const products = allProducts.filter((p) => p.status !== "archived");

  // Server-side pre-check: which products (active OR archived) have stored
  // macaroons? Intersecting against `allProducts` is critical — if we only
  // intersected against `products` (active-only), the hook would think
  // "no cookie for this media" and short-circuit, hiding the access of any
  // customer who paid for a now-archived product.
  const cookieStore = await cookies();
  const storedProductIds = getStoredProductIds(
    cookieStore.get(COOKIE_NAME)?.value,
    allProducts.map((p) => p.productId)
  );

  // Admin preview: validate session server-side. We re-derive the source from
  // Media.blob (URL only) so a logged-in admin can preview without going
  // through the paywall. For envelope-encrypted media (photo, article) the
  // admin preview goes through the dedicated /api/admin/media/[id]/preview
  // endpoint, which decrypts on the fly.
  let adminPreviewSourceUrl: string | null = null;
  if (preview === "admin") {
    try {
      const session = await auth();
      if (session?.user?.type === "admin") {
        const { parseMediaBlob } = await import("@/lib/schemas/media-blob");
        try {
          const parsed = parseMediaBlob(media.blob);
          if (parsed.kind === "url") adminPreviewSourceUrl = parsed.url;
        } catch {
          adminPreviewSourceUrl = null;
        }
      }
    } catch {
      // Not authenticated — ignore preview param
    }
  }

  // Preview images: direct URLs stored on Media.previewImageUrls. Uploaded
  // images live as bytes in the PreviewImage table and are referenced here
  // via `/api/images/<id>` URLs. Cap-of-6 enforced on read.
  const previewImages = (media.previewImageUrls || []).slice(0, 6);

  const thumbSrc = resolveMediaThumb(media);

  // Sibling-media list for the YouTube-style "up next" sidebar. Most-viewed
  // first (founder's choice — surface the channel's hits), current media
  // excluded, capped at 20 items. Stable secondary sort on id keeps the
  // order deterministic across tied view counts.
  const siblingDocs = await prisma.media.findMany({
    where: {
      channelId: channel.id,
      id: { not: media.id },
    },
    select: {
      id: true,
      name: true,
      thumbnailBytes: true,
      thumbnailUrl: true,
      mediaType: true,
      viewsCount: true,
      createdAt: true,
    },
    orderBy: [{ viewsCount: "desc" }, { id: "asc" }],
    take: 20,
  });

  const siblingMedia = siblingDocs.map((m) => ({
    _id: m.id,
    name: m.name,
    thumbnailSrc: resolveMediaThumb(m),
    mediaType: m.mediaType,
    viewsCount: m.viewsCount ?? 0,
    href: `/c/${slug}/${m.id}`,
    // YouTube-style "X views • Y days ago" — the createdAt is serialized as
    // an ISO string so the client component can format it via Intl.
    createdAt: m.createdAt.toISOString(),
  }));

  // JSON-LD structured data
  const mediaJsonLd = buildMediaSchema(
    {
      id: media.id,
      name: media.name,
      description: media.description,
      mediaType: media.mediaType,
      thumbnailUrl: media.thumbnailUrl,
      hasThumbnail: !!media.thumbnailBytes,
      createdAt: media.createdAt,
      updatedAt: media.updatedAt,
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
      _id: media.id,
      name: media.name,
      description: media.description,
      media_type: media.mediaType,
      thumbnail_url: media.thumbnailUrl,
      thumbnail_id: media.thumbnailBytes ? media.id : undefined,
      views_count: media.viewsCount,
      comments_count: media.commentsCount,
      likes_count: media.likesCount ?? 0,
      shares_count: media.sharesCount ?? 0,
      // For envelope-encrypted media (photo, article), surface the
      // EncryptedEnvelope id to the client so it can fetch the ciphertext
      // after unwrapping the DEK. The id lives in Media.blob.envelopeId.
      envelope_id:
        media.mediaType === "photo" || media.mediaType === "article"
          ? (() => {
              try {
                const parsed = (media.blob as { kind?: string; envelopeId?: string });
                return parsed.kind === media.mediaType ? parsed.envelopeId : undefined;
              } catch {
                return undefined;
              }
            })()
          : undefined,
    },
    channel: {
      name: channel.name,
      slug: channel.slug,
      // Avatar for the under-video ChannelBlock. Falls back gracefully to
      // an initial when both fields are absent.
      profileImageUrl: resolveChannelAvatar(channel),
    },
    products: products.map((p) => ({
      productId: p.productId,
      encryptedBlob: p.encryptedBlob as string,
      keyFingerprint: p.keyFingerprint ?? undefined,
      name: p.name ?? undefined,
      priceCents: p.priceCents ?? undefined,
      currency: p.currency ?? undefined,
      accessDurationSeconds: p.accessDurationSeconds ?? undefined,
      status: p.status ?? undefined,
    })),
    storedProductIds,
    previewImages,
    thumbSrc,
    locale,
    instanceConfig: { theme: { logo: instanceConfig.theme.logo }, name: instanceConfig.name },
    adminPreviewSourceUrl,
    siblingMedia,
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
