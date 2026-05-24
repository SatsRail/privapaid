import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { getInstanceConfig } from "@/config/instance";
import Channel from "@/models/Channel";
import Media from "@/models/Media";

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
  await connectDB();
  const { domain, nsfw: nsfwAllowed, locale } = await getInstanceConfig();

  const channel = await Channel.findOne({
    slug,
    active: true,
    deleted_at: null,
  })
    .select("name bio profile_image_url profile_image_id nsfw updated_at")
    .lean();

  if (!channel) {
    return new NextResponse("Channel not found", { status: 404 });
  }
  if (!nsfwAllowed && channel.nsfw) {
    return new NextResponse("Channel not found", { status: 404 });
  }

  const mediaItems = await Media.find({
    channel_id: channel._id,
    deleted_at: null,
  })
    .select("_id name description thumbnail_url thumbnail_id media_type created_at")
    .sort({ created_at: -1 })
    .limit(FEED_LIMIT)
    .lean();

  const baseUrl = `https://${domain}`;
  const channelUrl = `${baseUrl}/c/${slug}`;
  const feedUrl = `${channelUrl}/feed.xml`;
  const channelImage = channel.profile_image_id
    ? `${baseUrl}/api/images/${channel.profile_image_id}`
    : channel.profile_image_url;
  const lastBuild = rfc822(
    mediaItems[0]?.created_at instanceof Date
      ? mediaItems[0].created_at
      : (channel.updated_at instanceof Date ? channel.updated_at : new Date())
  );

  const items = mediaItems
    .map((m) => {
      const itemUrl = `${channelUrl}/${m._id}`;
      const thumb = m.thumbnail_id
        ? `${baseUrl}/api/images/${m.thumbnail_id}`
        : m.thumbnail_url;
      const descriptionHtml =
        (thumb ? `<p><img src="${escapeXml(thumb)}" alt="${escapeXml(m.name)}" /></p>` : "") +
        (m.description ? `<p>${escapeXml(m.description)}</p>` : "");
      return `    <item>
      <title>${escapeXml(m.name)}</title>
      <link>${escapeXml(itemUrl)}</link>
      <guid isPermaLink="true">${escapeXml(itemUrl)}</guid>
      <pubDate>${rfc822(m.created_at instanceof Date ? m.created_at : new Date())}</pubDate>
      <category>${escapeXml(m.media_type)}</category>
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
