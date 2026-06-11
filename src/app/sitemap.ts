import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";
import { getInstanceConfig } from "@/config/instance";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { domain, nsfw } = await getInstanceConfig();
  const baseUrl = `https://${domain}`;

  const entries: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1.0,
    },
  ];

  // Channels
  const channels = await prisma.channel.findMany({
    where: {
      active: true,
      deletedAt: null,
      ...(nsfw ? {} : { nsfw: false }),
    },
    select: { id: true, slug: true, updatedAt: true },
  });

  for (const channel of channels) {
    entries.push({
      url: `${baseUrl}/c/${channel.slug}`,
      lastModified: channel.updatedAt,
      changeFrequency: "weekly",
      priority: 0.8,
    });
  }

  // Media items for active channels
  const channelIds = channels.map((ch) => ch.id);
  const mediaItems = await prisma.media.findMany({
    where: { channelId: { in: channelIds }, deletedAt: null },
    select: { id: true, channelId: true, updatedAt: true },
  });

  // Build channel slug lookup
  const slugMap = new Map(channels.map((ch) => [ch.id, ch.slug]));

  for (const media of mediaItems) {
    const slug = slugMap.get(media.channelId);
    if (!slug) continue;

    entries.push({
      url: `${baseUrl}/c/${slug}/${media.id}`,
      lastModified: media.updatedAt,
      changeFrequency: "monthly",
      priority: 0.6,
    });
  }

  return entries;
}
