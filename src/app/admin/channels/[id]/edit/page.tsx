import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import config from "@/config/instance";
import ChannelForm from "../../ChannelForm";

export const dynamic = "force-dynamic";

export default async function EditChannelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [channel, categories] = await Promise.all([
    prisma.channel.findUnique({ where: { id } }),
    prisma.category.findMany({
      where: { active: true },
      orderBy: { position: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  if (!channel) notFound();

  const cats = categories.map((c) => ({
    _id: c.id,
    name: c.name,
  }));

  const profileImageId = channel.profileImageBytes ? channel.id : "";

  const serialized = {
    _id: channel.id,
    name: channel.name,
    slug: channel.slug,
    bio: channel.bio || "",
    category_id: channel.categoryId ?? null,
    nsfw: channel.nsfw,
    profile_image_url: channel.profileImageUrl || "",
    profile_image_id: profileImageId,
    social_links: (channel.socialLinks as Record<string, string>) || {},
    active: channel.active,
  };

  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <h1 className="text-2xl font-bold">Edit Channel</h1>
        {channel.ref != null && (
          <span className="rounded bg-[var(--theme-bg-secondary)] border border-[var(--theme-border)] px-2 py-0.5 font-mono text-xs text-[var(--theme-text-secondary)]">
            ch_{channel.ref}
          </span>
        )}
      </div>
      <ChannelForm
        categories={cats}
        nsfwEnabled={config.nsfw}
        initialData={serialized}
      />
    </div>
  );
}
