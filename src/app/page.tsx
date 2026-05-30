import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { resolveMediaImages } from "@/lib/images";
import { isSetupComplete } from "@/lib/setup";
import { getInstanceConfig } from "@/config/instance";
import { t } from "@/i18n";
import ViewerShell from "@/components/ViewerShell";
import HomeContent from "@/components/HomeContent";
import { buildWebSiteSchema, buildOrganizationSchema } from "@/lib/jsonld";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const instanceConfig = await getInstanceConfig();
  const logoUrl = instanceConfig.theme.logo || undefined;

  return {
    title: instanceConfig.name,
    description: instanceConfig.aboutText || `${instanceConfig.name} — powered by PrivaPaid`,
    alternates: { canonical: "/" },
    openGraph: {
      title: instanceConfig.name,
      description: instanceConfig.aboutText || `${instanceConfig.name} — powered by PrivaPaid`,
      type: "website",
      ...(logoUrl && { images: [{ url: logoUrl }] }),
    },
  };
}

export default async function HomePage() {
  const setupComplete = await isSetupComplete();
  if (!setupComplete) redirect("/setup");

  const instanceConfig = await getInstanceConfig();
  const { locale } = instanceConfig;

  const categories = await prisma.category.findMany({
    where: { active: true },
    orderBy: { position: "asc" },
  });

  const channels = await prisma.channel.findMany({
    where: {
      active: true,
      ...(instanceConfig.nsfw ? {} : { nsfw: false }),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      slug: true,
      name: true,
      profileImageUrl: true,
      profileImageBytes: true,
      categoryId: true,
    },
  });

  // Fetch media for active channels
  const channelIds = channels.map((ch) => ch.id);
  const mediaItems = await prisma.media.findMany({
    where: { channelId: { in: channelIds } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      name: true,
      description: true,
      mediaType: true,
      images: {
        select: { id: true, kind: true, externalUrl: true, position: true },
      },
      commentsCount: true,
      channelId: true,
    },
  });

  // Serialize for client component
  const serializedCategories = categories.map((cat) => ({
    _id: cat.id,
    name: cat.name,
  }));

  const serializedChannels = channels.map((ch) => ({
    _id: ch.id,
    slug: ch.slug,
    name: ch.name,
    // Pre-resolved avatar URL — see ViewerShell for the same pattern.
    // MediaCard joins this through `channelAvatarUrl`.
    profile_image_url: ch.profileImageBytes
      ? `/api/images/channel/${ch.id}`
      : ch.profileImageUrl,
    profile_image_id: undefined,
    category_id: ch.categoryId ?? undefined,
  }));

  const serializedMedia = mediaItems.map((m) => ({
    _id: m.id,
    name: m.name,
    description: m.description,
    media_type: m.mediaType,
    thumbnail_url: resolveMediaImages(m.images).thumbnailUrl,
    thumbnail_id: undefined,
    preview_image_ids: [],
    comments_count: m.commentsCount,
    channel_id: m.channelId,
  }));

  const webSiteSchema = buildWebSiteSchema(instanceConfig);
  const orgSchema = buildOrganizationSchema(instanceConfig);

  return (
    <ViewerShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([webSiteSchema, orgSchema]) }}
      />
      <HomeContent
        categories={serializedCategories}
        mediaItems={serializedMedia}
        channels={serializedChannels}
        emptyText={t(locale, "viewer.home.empty")}
      />
    </ViewerShell>
  );
}
