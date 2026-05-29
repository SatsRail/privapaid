import Link from "next/link";
import { t } from "@/i18n";

interface MediaBreadcrumbProps {
  channelName: string;
  channelSlug: string;
  mediaName: string;
  locale: string;
}

export default function MediaBreadcrumb({
  channelName,
  channelSlug,
  mediaName,
  locale,
}: MediaBreadcrumbProps) {
  const link =
    "rounded transition-colors hover:text-[var(--theme-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-primary)]";
  return (
    <div
      className="mb-4 text-sm"
      style={{ color: "var(--theme-text-secondary)" }}
    >
      <Link href="/" className={link}>
        {t(locale, "viewer.media.home")}
      </Link>
      {" / "}
      <Link href={`/c/${channelSlug}`} className={link}>
        {channelName}
      </Link>
      {" / "}
      <span style={{ color: "var(--theme-text)" }}>{mediaName}</span>
    </div>
  );
}
