"use client";

import Link from "next/link";

interface ChannelBlockProps {
  name: string;
  slug: string;
  profileImageUrl?: string;
}

/**
 * YouTube-style channel attribution row that sits under the action row.
 * Avatar (40px) + channel name — clicking either takes the viewer to
 * the channel page. The Subscribe affordance lives in the action row
 * above this block (see ActionRow's `channelSlug` prop).
 */
export default function ChannelBlock({ name, slug, profileImageUrl }: ChannelBlockProps) {
  // Channel initial fallback when no avatar is available — matches the
  // pattern in Sidebar/ChannelList for visual consistency.
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div
      className="mt-3 flex items-center gap-3"
      data-testid="channel-block"
    >
      <Link
        href={`/c/${slug}`}
        className="flex min-w-0 flex-1 items-center gap-3 group"
      >
        {profileImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profileImageUrl}
            alt={name}
            className="h-10 w-10 flex-shrink-0 rounded-full object-cover"
          />
        ) : (
          <div
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-semibold"
            style={{
              backgroundColor: "var(--theme-bg-secondary)",
              color: "var(--theme-text)",
            }}
          >
            {initial}
          </div>
        )}
        <div className="min-w-0">
          <p
            className="truncate text-sm font-medium group-hover:underline"
            style={{ color: "var(--theme-text)" }}
          >
            {name}
          </p>
        </div>
      </Link>
    </div>
  );
}
