"use client";

import Link from "next/link";
import { useLocale } from "@/i18n/useLocale";

interface ChannelBlockProps {
  name: string;
  slug: string;
  profileImageUrl?: string;
  /** Total media in the channel — drives the "N items" sub-label. Omitted
   *  or 0 hides the line (a "0 items" badge reads as broken). */
  mediaCount?: number;
}

/**
 * YouTube-style channel attribution row that sits under the action row.
 * A 48px avatar + a two-line stack (channel name over a media-count
 * sub-label) — clicking anywhere takes the viewer to the channel page.
 * The larger avatar + secondary count line give the block enough weight to
 * read as the page's "who made this" anchor rather than a throwaway byline.
 * No Subscribe button: channels expose an RSS feed for auto-discovery (see
 * ActionRow's doc comment).
 */
export default function ChannelBlock({ name, slug, profileImageUrl, mediaCount }: ChannelBlockProps) {
  const { t } = useLocale();
  // Channel initial fallback when no avatar is available — matches the
  // pattern in Sidebar/ChannelList for visual consistency.
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div
      className="mt-4 flex items-center gap-3"
      data-testid="channel-block"
    >
      <Link
        href={`/c/${slug}`}
        className="group -m-1 flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-primary)]"
      >
        {profileImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profileImageUrl}
            alt={name}
            className="h-12 w-12 flex-shrink-0 rounded-full object-cover"
          />
        ) : (
          <div
            className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full text-base font-semibold"
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
            className="truncate text-base font-semibold leading-tight group-hover:underline"
            style={{ color: "var(--theme-text)" }}
          >
            {name}
          </p>
          {/* Inline the count guard (rather than a derived bool) so TS narrows
              mediaCount to a number for the pluralized t() call. */}
          {typeof mediaCount === "number" && mediaCount > 0 && (
            <p
              className="mt-0.5 truncate text-xs"
              style={{ color: "var(--theme-text-secondary)" }}
            >
              {t("viewer.channel.media_count", { count: mediaCount })}
            </p>
          )}
        </div>
      </Link>
    </div>
  );
}
