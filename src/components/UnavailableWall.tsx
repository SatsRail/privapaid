import { t } from "@/i18n";

interface UnavailableWallProps {
  variant: "card" | "overlay";
  thumbnailUrl?: string;
  mediaName: string;
  locale: string;
  /**
   * Which copy to show. "unavailable" (default) is the generic
   * no-products-for-sale / locked state. "error" is the Part B
   * server-confirmed decrypt-failure state — reassuring "temporarily
   * unavailable, we're restoring it" wording rather than "not for sale".
   */
  reason?: "unavailable" | "error";
}

// Shared lock glyph so the card / overlay / no-thumbnail states stay visually
// identical. 22px inside a 48px chip reads calmer than a bare 48px icon.
function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export default function UnavailableWall({
  variant,
  thumbnailUrl,
  mediaName,
  locale,
  reason = "unavailable",
}: UnavailableWallProps) {
  const title = t(
    locale,
    reason === "error" ? "viewer.media.error_title" : "viewer.media.not_available"
  );
  const description = t(
    locale,
    reason === "error"
      ? "viewer.media.error_description"
      : "viewer.media.not_available_description"
  );

  if (variant === "card") {
    return (
      <div className="mb-6 max-w-[1280px]">
        <div className="flex flex-col items-center gap-3 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] px-6 py-8 text-center">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-full"
            style={{ backgroundColor: "var(--theme-bg)" }}
          >
            <LockIcon className="text-[var(--theme-text-secondary)]" />
          </div>
          <p className="text-base font-semibold" style={{ color: "var(--theme-text)" }}>
            {title}
          </p>
          <p className="max-w-sm text-sm" style={{ color: "var(--theme-text-secondary)" }}>
            {description}
          </p>
        </div>
      </div>
    );
  }

  // Overlay: a player-shaped frame (16:9, capped at the same 1280px as the
  // real video) so the locked state matches the player it stands in for and
  // never balloons on a square / portrait thumbnail (object-cover crops to
  // fill). A dimmed thumbnail sits behind a centered, frosted lock chip.
  return (
    <div className="relative mb-6 max-w-[1280px] overflow-hidden rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)]">
      {thumbnailUrl ? (
        <div className="relative aspect-video">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbnailUrl}
            alt={mediaName}
            className="h-full w-full object-cover opacity-30"
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 px-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15 backdrop-blur-sm">
              <LockIcon className="text-white/90" />
            </div>
            <p className="text-sm font-semibold text-white">{title}</p>
            <p className="max-w-xs text-xs text-white/70">{description}</p>
          </div>
        </div>
      ) : (
        <div className="flex aspect-video flex-col items-center justify-center gap-2 px-6 text-center">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-full"
            style={{ backgroundColor: "var(--theme-bg)" }}
          >
            <LockIcon className="text-[var(--theme-text-secondary)]" />
          </div>
          <p className="text-sm font-semibold" style={{ color: "var(--theme-text)" }}>
            {title}
          </p>
          <p className="max-w-xs text-xs" style={{ color: "var(--theme-text-secondary)" }}>
            {description}
          </p>
        </div>
      )}
    </div>
  );
}
