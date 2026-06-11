import Link from "next/link";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveMediaImages } from "@/lib/images";
import config, { getInstanceConfig } from "@/config/instance";
import { t } from "@/i18n";
import MediaCard from "@/components/MediaCard";
import ViewerShell from "@/components/ViewerShell";
import ServerPagination from "@/components/ui/ServerPagination";
import NotifyButton from "@/components/NotifyButton";
import { buttonClasses } from "@/components/ui/buttonStyles";
import { buildChannelSchema } from "@/lib/jsonld";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

const SORT_OPTIONS = [
  { key: "position", label: "Default", orderBy: { position: "asc" as const } },
  { key: "views", label: "Most viewed", orderBy: { viewsCount: "desc" as const } },
  { key: "latest", label: "Latest", orderBy: { createdAt: "desc" as const } },
] satisfies ReadonlyArray<{ key: string; label: string; orderBy: Prisma.MediaOrderByWithRelationInput }>;

type SortKey = (typeof SORT_OPTIONS)[number]["key"];

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const channel = await prisma.channel.findFirst({
    where: { slug, active: true, deletedAt: null },
    select: {
      id: true,
      name: true,
      bio: true,
      profileImageUrl: true,
      profileImageBytes: true,
    },
  });

  if (!channel) return { title: "Channel Not Found" };

  const instanceConfig = await getInstanceConfig();
  const description = channel.bio
    ? channel.bio.slice(0, 160)
    : undefined;
  const imageUrl = channel.profileImageBytes
    ? `/api/images/channel/${channel.id}`
    : channel.profileImageUrl
      || instanceConfig.theme.logo
      || undefined;

  return {
    title: channel.name,
    description,
    alternates: {
      canonical: `/c/${slug}`,
      types: {
        "application/rss+xml": [
          { url: `/c/${slug}/feed.xml`, title: `${channel.name} RSS` },
        ],
      },
    },
    openGraph: {
      title: channel.name,
      description,
      type: "profile",
      ...(imageUrl && { images: [{ url: imageUrl }] }),
    },
    twitter: {
      card: "summary",
      title: channel.name,
      description,
      ...(imageUrl && { images: [imageUrl] }),
    },
  };
}

export default async function ChannelPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const resolvedSearchParams = await searchParams;
  const parsedPage = Math.max(1, parseInt(String(resolvedSearchParams.page || "1"), 10) || 1);
  const sortParam = String(resolvedSearchParams.sort || "position") as SortKey;
  const activeSort = SORT_OPTIONS.find((o) => o.key === sortParam) || SORT_OPTIONS[0];

  const channel = await prisma.channel.findFirst({
    where: { slug, active: true, deletedAt: null },
    include: { category: { select: { name: true } } },
  });

  if (!channel) notFound();
  if (!config.nsfw && channel.nsfw) notFound();

  const totalMedia = await prisma.media.count({ where: { channelId: channel.id } });
  const totalPages = Math.ceil(totalMedia / PAGE_SIZE) || 1;
  const page = Math.min(parsedPage, totalPages);

  const media = await prisma.media.findMany({
    where: { channelId: channel.id, deletedAt: null },
    // Exclude sourceUrl from the listing — it's never needed for cards and
    // we don't want to leak content URLs.
    select: {
      id: true,
      name: true,
      description: true,
      mediaType: true,
      images: {
        select: { id: true, kind: true, externalUrl: true, position: true },
      },
      commentsCount: true,
      viewsCount: true,
    },
    orderBy: activeSort.orderBy,
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  // Fetch cached product prices for all media in this channel. Direct-sale
  // (media-scoped) products only — the channel bundle's price is rendered
  // separately by the channel header.
  const mediaIds = media.map((m) => m.id);
  const mediaProducts = await prisma.product.findMany({
    where: {
      mediaId: { in: mediaIds },
      productStatus: "active",
    },
    select: {
      mediaId: true,
      productPriceCents: true,
      productCurrency: true,
    },
  });

  const priceMap = new Map<string, { cents: number; currency: string }>();
  for (const mp of mediaProducts) {
    if (!mp.mediaId) continue;
    if (!priceMap.has(mp.mediaId) && mp.productPriceCents != null) {
      priceMap.set(mp.mediaId, {
        cents: mp.productPriceCents,
        currency: mp.productCurrency || "USD",
      });
    }
  }

  const instanceConfig = await getInstanceConfig();
  const { locale } = instanceConfig;
  const cat = channel.category;
  const socialLinks = Object.entries(
    (channel.socialLinks as Record<string, string>) || {}
  ).filter(([, v]) => v);
  const avatarSrc = channel.profileImageBytes
    ? `/api/images/channel/${channel.id}`
    : channel.profileImageUrl || "";

  // Web Push is available only when the operator configured all three VAPID env
  // vars. We pass the public key + an enabled flag to the client island; the
  // private key never leaves the server.
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || "";
  const pushEnabled = !!(
    vapidPublicKey &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_SUBJECT
  );

  const channelJsonLd = buildChannelSchema(
    {
      name: channel.name,
      slug: channel.slug,
      bio: channel.bio,
      profileImageUrl: channel.profileImageUrl,
      id: channel.id,
      hasProfileImage: !!channel.profileImageBytes,
    },
    instanceConfig
  );

  return (
    <ViewerShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(channelJsonLd) }}
      />
      <div className="px-6 py-8">
        {/* Channel header */}
        <div className="mb-8 flex items-start gap-4">
          {avatarSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarSrc}
              alt={channel.name}
              className="h-20 w-20 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-20 w-20 items-center justify-center rounded-full text-2xl font-bold" style={{ backgroundColor: "var(--theme-bg-secondary)", color: "var(--theme-text-secondary)" }}>
              {channel.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold">{channel.name}</h1>
            {cat?.name && (
              <p className="text-sm text-zinc-400">{cat.name}</p>
            )}
            {channel.bio && (
              <p className="mt-2 text-zinc-300">{channel.bio}</p>
            )}
            {socialLinks.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-3 text-sm">
                {socialLinks.map(([platform, url]) => (
                  <a
                    key={platform}
                    href={url as string}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-400 hover:text-[var(--theme-primary)]"
                  >
                    {platform}
                  </a>
                ))}
              </div>
            )}
            {/* New-content discovery: a visible RSS link (server-rendered) and
                an opt-in Web Push button (client island). Both let viewers
                follow the channel for new uploads without an account. */}
            <div className="mt-3 flex flex-wrap items-start gap-2">
              <a
                href={`/c/${slug}/feed.xml`}
                target="_blank"
                rel="noopener"
                title={t(locale, "viewer.rss.title")}
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M4 11a9 9 0 0 1 9 9h2.5A11.5 11.5 0 0 0 4 8.5V11z" />
                  <path d="M4 4a16 16 0 0 1 16 16h2.5A18.5 18.5 0 0 0 4 1.5V4z" />
                  <circle cx="5.5" cy="18.5" r="2.5" />
                </svg>
                <span>{t(locale, "viewer.rss.label")}</span>
              </a>
              {pushEnabled && (
                <NotifyButton
                  channelSlug={channel.slug}
                  vapidPublicKey={vapidPublicKey}
                />
              )}
            </div>
          </div>
        </div>

        {/* Sort + count */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">
            {t(locale, "viewer.channel.media_count", { count: totalMedia })}
          </h2>
          {totalMedia > 1 && (
            <div className="flex gap-1.5">
              {SORT_OPTIONS.map((opt) => (
                <Link
                  key={opt.key}
                  href={opt.key === "position" ? `/c/${slug}` : `/c/${slug}?sort=${opt.key}`}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    activeSort.key === opt.key
                      ? "bg-[var(--theme-primary)] text-white"
                      : "bg-[var(--theme-bg-secondary)] text-[var(--theme-text-secondary)] hover:text-[var(--theme-text)]"
                  }`}
                >
                  {opt.label}
                </Link>
              ))}
            </div>
          )}
        </div>

        {media.length > 0 ? (
          <div className="grid gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {media.map((m) => {
              // Pre-resolve the thumbnail from the MediaImage relation
              // (byte-backed → /api/images/<id>, url-backed → externalUrl) and
              // pass it through as `thumbnail_url`. The channel avatar is
              // resolved the same way above as `avatarSrc`.
              const cardThumb = resolveMediaImages(m.images).thumbnailUrl;
              return (
                <MediaCard
                  key={m.id}
                  channelSlug={channel.slug}
                  channelName={channel.name}
                  channelAvatarUrl={avatarSrc}
                  media={{
                    _id: m.id,
                    name: m.name,
                    description: m.description,
                    media_type: m.mediaType,
                    thumbnail_url: cardThumb,
                    preview_image_ids: [],
                    comments_count: m.commentsCount,
                    views_count: m.viewsCount,
                  }}
                  price={priceMap.get(m.id)}
                />
              );
            })}
          </div>
        ) : (
          <p className="py-8 text-center text-zinc-500">
            {t(locale, "viewer.channel.empty")}
          </p>
        )}

        <ServerPagination
          page={page}
          totalPages={totalPages}
          baseUrl={`/c/${slug}`}
          searchParams={activeSort.key !== "position" ? { sort: activeSort.key } : undefined}
        />
      </div>
    </ViewerShell>
  );
}
