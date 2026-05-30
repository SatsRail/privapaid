import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveMediaImages } from "@/lib/images";
import { getInstanceConfig } from "@/config/instance";

export const dynamic = "force-dynamic";

const FEED_LIMIT = 50;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rfc822(date: Date): string {
  return date.toUTCString();
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const { domain, nsfw: nsfwAllowed, locale } = await getInstanceConfig();

  const channel = await prisma.channel.findFirst({
    where: {
      slug,
      active: true,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      bio: true,
      profileImageUrl: true,
      profileImageBytes: true,
      nsfw: true,
      updatedAt: true,
    },
  });

  if (!channel) {
    return new NextResponse("Channel not found", { status: 404 });
  }
  if (!nsfwAllowed && channel.nsfw) {
    return new NextResponse("Channel not found", { status: 404 });
  }

  const mediaItems = await prisma.media.findMany({
    where: {
      channelId: channel.id,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      description: true,
      images: {
        select: { id: true, kind: true, externalUrl: true, position: true },
      },
      mediaType: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: FEED_LIMIT,
  });

  const baseUrl = `https://${domain}`;
  const channelUrl = `${baseUrl}/c/${slug}`;
  const feedUrl = `${channelUrl}/feed.xml`;
  const channelImage = channel.profileImageBytes
    ? `${baseUrl}/api/images/channel/${channel.id}`
    : channel.profileImageUrl;
  const lastBuild = rfc822(
    mediaItems[0]?.createdAt ?? channel.updatedAt ?? new Date()
  );

  const items = mediaItems
    .map((m) => {
      const itemUrl = `${channelUrl}/${m.id}`;
      // Resolved thumbnail is app-relative (/api/images/<id>) for byte-backed
      // rows; RSS needs an absolute URL, so prefix the origin. External links
      // are already absolute and pass through.
      const rawThumb = resolveMediaImages(m.images).thumbnailUrl;
      const thumb = rawThumb.startsWith("/") ? `${baseUrl}${rawThumb}` : rawThumb;
      const descriptionHtml =
        (thumb ? `<p><img src="${escapeXml(thumb)}" alt="${escapeXml(m.name)}" /></p>` : "") +
        (m.description ? `<p>${escapeXml(m.description)}</p>` : "");
      return `    <item>
      <title>${escapeXml(m.name)}</title>
      <link>${escapeXml(itemUrl)}</link>
      <guid isPermaLink="true">${escapeXml(itemUrl)}</guid>
      <pubDate>${rfc822(m.createdAt)}</pubDate>
      <category>${escapeXml(m.mediaType)}</category>
      <description><![CDATA[${descriptionHtml}]]></description>
    </item>`;
    })
    .join("\n");

  const channelImageBlock = channelImage
    ? `    <image>
      <url>${escapeXml(channelImage)}</url>
      <title>${escapeXml(channel.name)}</title>
      <link>${escapeXml(channelUrl)}</link>
    </image>\n`
    : "";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(channel.name)}</title>
    <link>${escapeXml(channelUrl)}</link>
    <description>${escapeXml(channel.bio || channel.name)}</description>
    <language>${escapeXml(locale || "en")}</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
${channelImageBlock}${items}
  </channel>
</rss>
`;

  return new NextResponse(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
