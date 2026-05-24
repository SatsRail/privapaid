import Link from "next/link";
import { t } from "@/i18n";
import { formatTimeAgo } from "@/lib/relative-time";
import type { SiblingMediaItem } from "@/app/c/[slug]/[mediaId]/types";

interface ChannelSidebarItemProps {
  item: SiblingMediaItem;
  locale: string;
}

/**
 * One row in the YouTube-style sidebar. Horizontal layout: 168×94 (16:9)
 * thumbnail on the left, title + meta on the right. Title clamped to two
 * lines so long titles don't blow up the row height.
 *
 * Click target is the entire row — wrapped in Next's <Link> with
 * prefetch=false (sidebars typically have 10–20 items; prefetching all of
 * them would burn bandwidth for navigation that mostly won't happen).
 *
 * Pure presenter — accepts a pre-serialized item from the server. No data
 * fetching, no client state. Memoization-friendly because every prop is
 * primitive or stable string.
 */
export default function ChannelSidebarItem({ item, locale }: ChannelSidebarItemProps) {
  // Reuse the existing pluralized translation keys so the sidebar matches
  // the rest of the app's "N views / 1 view" copy.
  const localizedViews = t(locale, "viewer.media.views", { count: item.viewsCount });
  // YouTube's sub-label is "12K views • 3 days ago" — relative time turns
  // the static list of recommendations into a freshness signal.
  const relativeTime = formatTimeAgo(item.createdAt, locale);

  return (
    <Link
      href={item.href}
      prefetch={false}
      className="group flex gap-2 rounded-lg p-1 transition-colors hover:bg-white/5"
      data-testid="channel-sidebar-item"
    >
      <div
        className="relative w-[168px] flex-shrink-0 overflow-hidden rounded-lg bg-zinc-800"
        style={{ aspectRatio: "16 / 9" }}
      >
        {item.thumbnailSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumbnailSrc}
            alt={item.name}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-zinc-500">
            {item.mediaType}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p
          className="text-sm font-medium leading-snug line-clamp-2"
          style={{ color: "var(--theme-text)" }}
          title={item.name}
        >
          {item.name}
        </p>
        {(item.viewsCount > 0 || relativeTime) && (
          <p
            className="mt-1 text-xs"
            style={{ color: "var(--theme-text-secondary)" }}
          >
            {item.viewsCount > 0 && relativeTime
              ? `${localizedViews} • ${relativeTime}`
              : item.viewsCount > 0
                ? localizedViews
                : relativeTime}
          </p>
        )}
      </div>
    </Link>
  );
}
