import { t } from "@/i18n";

interface MediaMetaProps {
  viewsCount: number;
  locale: string;
}

/**
 * The thin meta row that sits between the content (video/photo/article) and
 * the description — YouTube-style placement. Kept as its own component so
 * the MediaLayout JSX doesn't sprout one-off spans, and so future additions
 * (publish date, category, etc.) land in one place.
 *
 * Renders nothing when `viewsCount` is 0. The video has been viewed but no
 * useful information is conveyed by "0 views"; suppressing it keeps the
 * page tidy on fresh uploads.
 */
export default function MediaMeta({ viewsCount, locale }: MediaMetaProps) {
  if (viewsCount <= 0) return null;
  return (
    <div
      className="mt-2 flex gap-3 text-sm"
      style={{ color: "var(--theme-text-secondary)" }}
    >
      <span>{t(locale, "viewer.media.views", { count: viewsCount })}</span>
    </div>
  );
}
