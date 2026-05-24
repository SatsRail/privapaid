import { connectDB } from "@/lib/mongodb";
import { getInstanceConfig } from "@/config/instance";
import Channel from "@/models/Channel";
import Category from "@/models/Category";
import Sidebar from "@/components/Sidebar";

interface ViewerShellProps {
  children: React.ReactNode;
}

export default async function ViewerShell({ children }: ViewerShellProps) {
  await connectDB();
  const instanceConfig = await getInstanceConfig();

  const categories = await Category.find({ active: true })
    .sort({ position: 1 })
    .select("name")
    .lean();

  const channelFilter: Record<string, unknown> = { active: true };
  if (!instanceConfig.nsfw) {
    channelFilter.nsfw = false;
  }

  const channels = await Channel.find(channelFilter)
    .select("slug name profile_image_url profile_image_id media_count is_live category_id")
    .sort({ created_at: -1 })
    .lean();

  // Group by category for sidebar
  const channelsByCategory: Record<string, typeof channels> = {};
  const uncategorized: typeof channels = [];

  for (const ch of channels) {
    const catId = ch.category_id?.toString();
    if (catId) {
      if (!channelsByCategory[catId]) channelsByCategory[catId] = [];
      channelsByCategory[catId].push(ch);
    } else {
      uncategorized.push(ch);
    }
  }

  // Serialize for client component
  const serializedChannels = channels.map((ch) => ({
    _id: ch._id.toString(),
    slug: ch.slug,
    name: ch.name,
    profile_image_url: ch.profile_image_url,
    profile_image_id: ch.profile_image_id,
    media_count: ch.media_count,
    is_live: ch.is_live,
  }));

  const serializedCategories = categories.map((cat) => ({
    _id: cat._id.toString(),
    name: cat.name,
  }));

  const serializedByCategory: Record<string, typeof serializedChannels> = {};
  for (const [catId, chs] of Object.entries(channelsByCategory)) {
    serializedByCategory[catId] = chs.map((ch) => ({
      _id: ch._id.toString(),
      slug: ch.slug,
      name: ch.name,
      profile_image_url: ch.profile_image_url,
      profile_image_id: ch.profile_image_id,
      media_count: ch.media_count,
      is_live: ch.is_live,
    }));
  }

  const serializedUncategorized = uncategorized.map((ch) => ({
    _id: ch._id.toString(),
    slug: ch.slug,
    name: ch.name,
    profile_image_url: ch.profile_image_url,
    profile_image_id: ch.profile_image_id,
    media_count: ch.media_count,
    is_live: ch.is_live,
  }));

  return (
    <div className="min-h-[calc(100vh-3.5rem)]">
      {/* Sidebar is a `fixed` overlay drawer — it doesn't take horizontal
          space in the document flow. The 72px desktop spacer it used to
          render alongside is gone, so <main> spans the full viewport width
          regardless of the rail's open / closed state. */}
      <Sidebar
        channels={serializedChannels}
        categories={serializedCategories}
        channelsByCategory={serializedByCategory}
        uncategorized={serializedUncategorized}
      />
      <main className="min-w-0">{children}</main>
    </div>
  );
}
