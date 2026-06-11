import { prisma } from "@/lib/prisma";
import { getInstanceConfig } from "@/config/instance";
import Sidebar from "@/components/Sidebar";

interface ViewerShellProps {
  children: React.ReactNode;
}

export default async function ViewerShell({ children }: ViewerShellProps) {
  const instanceConfig = await getInstanceConfig();

  const categories = await prisma.category.findMany({
    where: { active: true },
    orderBy: { position: "asc" },
    select: { id: true, name: true },
  });

  const channels = await prisma.channel.findMany({
    where: {
      active: true,
      deletedAt: null,
      ...(instanceConfig.nsfw ? {} : { nsfw: false }),
    },
    select: {
      id: true,
      slug: true,
      name: true,
      profileImageUrl: true,
      profileImageBytes: true,
      mediaCount: true,
      isLive: true,
      categoryId: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // The bytea-backed image route lives at /api/images/channel/<id>. Resolve
  // here so client components can drop straight into <img src>.
  function channelAvatar(ch: typeof channels[number]): string {
    if (ch.profileImageBytes) return `/api/images/channel/${ch.id}`;
    return ch.profileImageUrl;
  }

  // Group by category for sidebar
  const channelsByCategory: Record<string, typeof channels> = {};
  const uncategorized: typeof channels = [];

  for (const ch of channels) {
    const catId = ch.categoryId;
    if (catId) {
      if (!channelsByCategory[catId]) channelsByCategory[catId] = [];
      channelsByCategory[catId].push(ch);
    } else {
      uncategorized.push(ch);
    }
  }

  // Serialize for client component. We pass the pre-resolved avatar URL
  // through `profile_image_url` and leave `profile_image_id` undefined —
  // matching the Sidebar component's existing snake_case props contract.
  function serialize(ch: typeof channels[number]) {
    return {
      _id: ch.id,
      slug: ch.slug,
      name: ch.name,
      profile_image_url: channelAvatar(ch),
      profile_image_id: undefined,
      media_count: ch.mediaCount,
      is_live: ch.isLive,
    };
  }

  const serializedChannels = channels.map(serialize);

  const serializedCategories = categories.map((cat) => ({
    _id: cat.id,
    name: cat.name,
  }));

  const serializedByCategory: Record<string, typeof serializedChannels> = {};
  for (const [catId, chs] of Object.entries(channelsByCategory)) {
    serializedByCategory[catId] = chs.map(serialize);
  }

  const serializedUncategorized = uncategorized.map(serialize);

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
