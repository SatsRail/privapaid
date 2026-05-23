import AccessTimerPill from "@/components/AccessTimerPill";
import { t } from "@/i18n";
import type { SerializedProduct } from "@/app/c/[slug]/[mediaId]/types";

interface MediaHeaderProps {
  name: string;
  products: SerializedProduct[];
  /**
   * Retained on the interface so callers can pass it through without
   * coupling to the layout's meta-row placement. The header itself does
   * not render views — that moved under the content (see MediaLayout's
   * MediaMeta below the player) so the title + price/clock pills stay
   * tight. YouTube-style placement.
   */
  viewsCount?: number;
  commentsCount?: number;
  locale: string;
  remainingSeconds?: number | null;
}

export default function MediaHeader({
  name,
  products,
  locale,
  remainingSeconds,
}: MediaHeaderProps) {
  const pricePill = (() => {
    if (products.length === 0) return null;
    const prices = products
      .filter((p) => p.priceCents != null)
      .map((p) => ({ cents: p.priceCents!, currency: p.currency || "USD" }));
    if (prices.length === 0) return null;
    const lowest = prices.reduce((a, b) => (a.cents <= b.cents ? a : b));
    const formatted = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: lowest.currency,
      minimumFractionDigits: lowest.cents % 100 === 0 ? 0 : 2,
    }).format(lowest.cents / 100);
    return (
      <span
        className="inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold"
        style={{ backgroundColor: "var(--theme-primary)", color: "var(--theme-bg, #000)" }}
      >
        {prices.length > 1 ? `${t(locale, "viewer.media.from")} ${formatted}` : formatted}
      </span>
    );
  })();

  const hasTimeGated = products.some((p) => p.accessDurationSeconds != null);
  // A product with no `accessDurationSeconds` (null/undefined) is lifetime-access.
  // Show the Lifetime tag when at least one product offers lifetime AND no
  // product imposes a time gate — otherwise the running clock from the
  // time-gated product takes precedence.
  const hasLifetime =
    products.length > 0 &&
    !hasTimeGated &&
    products.some((p) => p.accessDurationSeconds == null);

  // `remainingSeconds` is set when (and only when) the viewer has a verified
  // active macaroon for this media — set after fresh payment, by the
  // mount-time access check on a returning visitor, and by every successful
  // heartbeat. It IS the "user has paid" signal at this component layer.
  const hasActiveAccess = remainingSeconds != null && remainingSeconds > 0;
  // When access is active the price pill is misleading — they've already
  // paid. Swap it out for the access clock (time-gated) or just hide it
  // (lifetime, where the lifetime tag carries the meaning).
  const hasActiveTimedAccess = hasTimeGated && hasActiveAccess;
  const showPricePill = !hasActiveAccess;

  return (
    <div className="mb-6">
      {/* YouTube's watch-page title is medium-weight, slightly smaller than
          a typical bold h1. Roboto medium at this size reads as authoritative
          without shouting. */}
      <h1 className="text-xl font-medium">{name}</h1>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        {hasActiveTimedAccess && (
          <AccessTimerPill serverSeconds={remainingSeconds!} locale={locale} />
        )}
        {hasLifetime && (
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-3 py-1 text-sm font-medium text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200"
            data-testid="lifetime-tag"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2l2.39 7.36H22l-6.18 4.49L18.21 22 12 17.27 5.79 22l2.39-8.15L2 9.36h7.61z" />
            </svg>
            {t(locale, "viewer.payment.lifetime")}
          </span>
        )}
        {showPricePill && pricePill}
      </div>
    </div>
  );
}
