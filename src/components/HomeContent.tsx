"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import CategoryChips from "@/components/CategoryChips";
import MediaCard from "@/components/MediaCard";

interface MediaItem {
  _id: string;
  name: string;
  description: string;
  media_type: string;
  thumbnail_url: string;
  thumbnail_id?: string;
  preview_image_ids?: string[];
  comments_count: number;
  channel_id: string;
}

interface ChannelInfo {
  _id: string;
  slug: string;
  name: string;
  profile_image_url: string;
  profile_image_id?: string;
  category_id?: string;
}

interface HomeContentProps {
  categories: { _id: string; name: string }[];
  mediaItems: MediaItem[];
  channels: ChannelInfo[];
  emptyText: string;
}

export default function HomeContent({ categories, mediaItems, channels, emptyText }: HomeContentProps) {
  const searchParams = useSearchParams();
  const initialCategory = searchParams.get("category");
  const [activeCategory, setActiveCategory] = useState<string | null>(initialCategory);

  // Build channel lookup
  const channelMap = new Map<string, ChannelInfo>();
  for (const ch of channels) {
    channelMap.set(ch._id, ch);
  }

  // Build set of channel IDs in active category
  const channelIdsInCategory = activeCategory
    ? new Set(channels.filter((ch) => ch.category_id === activeCategory).map((ch) => ch._id))
    : null;

  // Filter media
  const filteredMedia = channelIdsInCategory
    ? mediaItems.filter((m) => channelIdsInCategory.has(m.channel_id))
    : mediaItems;

  return (
    <div className="px-6 py-6">
      {/* Category filter chips */}
      {categories.length > 0 && (
        <div className="sticky top-14 z-30 -mx-6 px-6 py-3" style={{ backgroundColor: "var(--theme-bg)" }}>
          <CategoryChips
            categories={categories}
            activeCategory={activeCategory}
            onSelect={setActiveCategory}
          />
        </div>
      )}

      {/* Media grid */}
      {filteredMedia.length > 0 ? (
        <div className="grid gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredMedia.map((media) => {
            const ch = channelMap.get(media.channel_id);
            if (!ch) return null;
            return (
              <MediaCard
                key={media._id}
                channelSlug={ch.slug}
                channelName={ch.name}
                channelAvatarUrl={ch.profile_image_url}
                channelAvatarId={ch.profile_image_id}
                media={media}
              />
            );
          })}
        </div>
      ) : (
        <div className="py-20 text-center">
          <p className="text-lg" style={{ color: "var(--theme-text-secondary)" }}>
            {emptyText}
          </p>
        </div>
      )}
    </div>
  );
}
