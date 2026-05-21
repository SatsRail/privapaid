import { redirect } from "next/navigation";
import { connectDB } from "@/lib/mongodb";
import { isSetupComplete } from "@/lib/setup";
import { getInstanceConfig } from "@/config/instance";
import { t } from "@/i18n";
import Channel from "@/models/Channel";
import Category from "@/models/Category";
import Media from "@/models/Media";
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
  await connectDB();

  const setupComplete = await isSetupComplete();
  if (!setupComplete) redirect("/setup");

  const instanceConfig = await getInstanceConfig();
  const { locale } = instanceConfig;

  const categories = await Category.find({ active: true })
    .sort({ position: 1 })
    .lean();

  const channelFilter: Record<string, unknown> = { active: true };
  if (!instanceConfig.nsfw) {
    channelFilter.nsfw = false;
  }

  const channels = await Channel.find(channelFilter)
    .sort({ created_at: -1 })
    .limit(100)
    .lean();

  // Fetch media for active channels
  const channelIds = channels.map((ch) => ch._id);
  const mediaItems = await Media.find({ channel_id: { $in: channelIds } })
    .sort({ created_at: -1 })
    .limit(100)
    .lean();

  // Serialize for client component
  const serializedCategories = categories.map((cat) => ({
    _id: cat._id.toString(),
    name: cat.name,
  }));

  const serializedChannels = channels.map((ch) => ({
    _id: ch._id.toString(),
    slug: ch.slug,
    name: ch.name,
    profile_image_url: ch.profile_image_url,
    profile_image_id: ch.profile_image_id,
    category_id: ch.category_id?.toString(),
  }));

  const serializedMedia = mediaItems.map((m) => ({
    _id: m._id.toString(),
    name: m.name,
    description: m.description,
    media_type: m.media_type,
    thumbnail_url: m.thumbnail_url,
    thumbnail_id: m.thumbnail_id,
    preview_image_ids: m.preview_image_ids || [],
    comments_count: m.comments_count,
    channel_id: m.channel_id.toString(),
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
