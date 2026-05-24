"use client";

import Link from "next/link";
import { useLocale } from "@/i18n/useLocale";

interface ChannelBlockProps {
  name: string;
  slug: string;
  profileImageUrl?: string;
}

/**
 * YouTube-style channel attribution row that sits under the action row.
 * Avatar (40px) + channel name + "Subscribe" pill. Click avatar/name →
 * channel page. Click Subscribe → opens the channel's RSS feed in a new
 * tab, letting the viewer's RSS reader (Feedly, NetNewsWire, Inoreader,
 * Reeder, etc.) subscribe. Browser RSS extensions also catch the feed
 * via the `<link rel="alternate" type="application/rss+xml">` on the
 * channel page itself.
 *
 * RSS is the real, working subscription mechanism — no per-user backend
 * needed, no email harvesting, works across every reader the viewer
 * already uses. The feed is at /c/{slug}/feed.xml.
 */
export default function ChannelBlock({ name, slug, profileImageUrl }: ChannelBlockProps) {
  const { t } = useLocale();

  // Channel initial fallback when no avatar is available — matches the
  // pattern in Sidebar/ChannelList for visual consistency.
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div
      className="mt-3 flex items-center justify-between gap-3"
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
      <a
        href={`/c/${slug}/feed.xml`}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="subscribe-button"
        title={t("viewer.channel.subscribe_hint")}
        className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition-colors hover:opacity-90"
        style={{
          backgroundColor: "var(--theme-text)",
          color: "var(--theme-bg)",
        }}
      >
        {/* Standard RSS icon — the same orange-feed glyph viewers recognize. */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M6.18 15.64a2.18 2.18 0 1 1 0 4.36 2.18 2.18 0 0 1 0-4.36zM4 4.44A15.56 15.56 0 0 1 19.56 20H16.5A12.5 12.5 0 0 0 4 7.5V4.44zm0 5.66A9.9 9.9 0 0 1 13.9 20H10.83A6.83 6.83 0 0 0 4 13.17V10.1z" />
        </svg>
        <span>{t("viewer.channel.subscribe")}</span>
      </a>
    </div>
  );
}
