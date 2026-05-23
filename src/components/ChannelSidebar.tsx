import ChannelSidebarItem from "@/components/ChannelSidebarItem";
import { t } from "@/i18n";
import type { SiblingMediaItem } from "@/app/c/[slug]/[mediaId]/types";

interface ChannelSidebarProps {
  items: SiblingMediaItem[];
  locale: string;
}

/**
 * YouTube-style "up next" rail. Shows up to 20 other media items from the
 * same channel, sorted by views_count desc (server-decided).
 *
 * Empty list → render nothing. A channel-of-one shouldn't surface an empty
 * column; the MediaLayout collapses to single-column in that case.
 *
 * Pure server component — no client state. Items are pre-serialized by the
 * page server component so this presenter doesn't need to know about slugs
 * or thumbnail resolution.
 */
export default function ChannelSidebar({ items, locale }: ChannelSidebarProps) {
  if (items.length === 0) return null;

  return (
    <aside
      data-testid="channel-sidebar"
      aria-label={t(locale, "viewer.sidebar.more_from_channel")}
    >
      <h2
        className="mb-3 text-sm font-medium"
        style={{ color: "var(--theme-text-secondary)" }}
      >
        {t(locale, "viewer.sidebar.more_from_channel")}
      </h2>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item._id}>
            <ChannelSidebarItem item={item} locale={locale} />
          </li>
        ))}
      </ul>
    </aside>
  );
}
