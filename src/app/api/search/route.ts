import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import config from "@/config/instance";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  // No more regex escaping — Postgres `contains` (ILIKE under the hood when
  // mode: "insensitive") treats the query as a literal substring.
  const channelWhere: Record<string, unknown> = {
    active: true,
    OR: [
      { name: { contains: q, mode: "insensitive" } },
      { bio: { contains: q, mode: "insensitive" } },
      // slug is citext so case-insensitive comes for free
      { slug: { contains: q } },
    ],
  };
  if (!config.nsfw) {
    channelWhere.nsfw = false;
  }

  const [channels, mediaItems] = await Promise.all([
    prisma.channel.findMany({
      where: channelWhere,
      select: {
        id: true,
        slug: true,
        name: true,
        profileImageUrl: true,
        profileImageMimeType: true,
      },
      take: 5,
    }),
    prisma.media.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        name: true,
        mediaType: true,
        channelId: true,
        thumbnailUrl: true,
        thumbnailMimeType: true,
      },
      take: 10,
    }),
  ]);

  // Build channel slug lookup for media results
  const channelIds = [...new Set(mediaItems.map((m) => m.channelId))];
  const mediaChannels = channelIds.length
    ? await prisma.channel.findMany({
        where: {
          id: { in: channelIds },
          active: true,
          ...(config.nsfw ? {} : { nsfw: false }),
        },
        select: { id: true, slug: true, name: true },
      })
    : [];

  const slugMap = new Map<string, string>();
  for (const ch of mediaChannels) {
    slugMap.set(ch.id, ch.slug);
  }

  const results: Array<{
    type: "channel" | "media";
    id: string;
    name: string;
    slug: string;
    channelSlug?: string;
    mediaType?: string;
  }> = [];

  for (const ch of channels) {
    results.push({
      type: "channel",
      id: ch.id,
      name: ch.name,
      slug: ch.slug,
    });
  }

  for (const m of mediaItems) {
    const channelSlug = slugMap.get(m.channelId);
    if (!channelSlug) continue; // skip media from inactive/nsfw-hidden channels
    results.push({
      type: "media",
      id: m.id,
      name: m.name,
      slug: m.id,
      channelSlug,
      mediaType: m.mediaType,
    });
  }

  return NextResponse.json({ results });
}
