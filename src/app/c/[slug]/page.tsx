import Link from "next/link";
import { notFound } from "next/navigation";
import { connectDB } from "@/lib/mongodb";
import Channel from "@/models/Channel";
import Media from "@/models/Media";
import MediaProduct from "@/models/MediaProduct";
import Customer from "@/models/Customer";
import config, { getInstanceConfig } from "@/config/instance";
import { t } from "@/i18n";
import MediaCard from "@/components/MediaCard";
import FavoriteButton from "@/components/FavoriteButton";
import ViewerShell from "@/components/ViewerShell";
import ServerPagination from "@/components/ui/ServerPagination";
import { resolveImageUrl } from "@/lib/images";
import { auth } from "@/lib/auth";
import { buildChannelSchema } from "@/lib/jsonld";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

const SORT_OPTIONS = [
  { key: "position", label: "Default", sort: { position: 1 } },
  { key: "views", label: "Most viewed", sort: { views_count: -1 } },
  { key: "comments", label: "Most commented", sort: { comments_count: -1 } },
  { key: "latest", label: "Latest", sort: { created_at: -1 } },
] as const;

type SortKey = (typeof SORT_OPTIONS)[number]["key"];

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  await connectDB();
  const channel = await Channel.findOne({ slug, active: true })
    .select("name bio profile_image_url profile_image_id")
    .lean();

  if (!channel) return { title: "Channel Not Found" };

  const instanceConfig = await getInstanceConfig();
  const description = channel.bio
    ? channel.bio.slice(0, 160)
    : undefined;
  const imageUrl = channel.profile_image_id
    ? `/api/images/${channel.profile_image_id}`
    : channel.profile_image_url
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
  await connectDB();

  const channel = await Channel.findOne({ slug, active: true })
    .populate("category_id", "name")
    .lean();

  if (!channel) notFound();
  if (!config.nsfw && channel.nsfw) notFound();

  const totalMedia = await Media.countDocuments({ channel_id: channel._id });
  const totalPages = Math.ceil(totalMedia / PAGE_SIZE) || 1;
  const page = Math.min(parsedPage, totalPages);

  const media = await Media.find({ channel_id: channel._id })
    .select("-source_url")
    .sort(activeSort.sort)
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();

  // Fetch cached product prices for all media in this channel
  const mediaIds = media.map((m) => m._id);
  const mediaProducts = await MediaProduct.find({
    media_id: { $in: mediaIds },
    product_status: "active",
  })
    .select("media_id product_price_cents product_currency")
    .lean();

  const priceMap = new Map<string, { cents: number; currency: string }>();
  for (const mp of mediaProducts) {
    const key = String(mp.media_id);
    if (!priceMap.has(key) && mp.product_price_cents != null) {
      priceMap.set(key, {
        cents: mp.product_price_cents,
        currency: mp.product_currency || "USD",
      });
    }
  }

  // Check if current customer has favorited this channel
  const session = await auth();
  let isFavorited = false;
  if (session?.user?.role === "customer" && session.user.id) {
    const customer = await Customer.findById(session.user.id)
      .select("favorite_channel_ids")
      .lean();
    isFavorited = customer?.favorite_channel_ids?.some(
      (id: unknown) => id?.toString() === channel._id.toString()
    ) ?? false;
  }

  const instanceConfig = await getInstanceConfig();
  const { locale } = instanceConfig;
  const cat = channel.category_id as { name?: string } | null;
  const socialLinks = Object.entries(channel.social_links || {}).filter(
    ([, v]) => v
  );
  const avatarSrc = resolveImageUrl(channel.profile_image_id, channel.profile_image_url);

  const channelJsonLd = buildChannelSchema(
    {
      name: channel.name,
      slug: channel.slug,
      bio: channel.bio,
      profile_image_url: channel.profile_image_url,
      profile_image_id: channel.profile_image_id,
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
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">{channel.name}</h1>
              <FavoriteButton
                channelId={channel._id.toString()}
                initialFavorited={isFavorited}
              />
            </div>
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
            {media.map((m) => (
              <MediaCard
                key={String(m._id)}
                channelSlug={channel.slug}
                channelName={channel.name}
                channelAvatarUrl={channel.profile_image_url}
                channelAvatarId={channel.profile_image_id}
                media={m}
                price={priceMap.get(String(m._id))}
              />
            ))}
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
