import type { TranslatorFn } from "@/i18n";

/**
 * Format a fiat amount as a localized currency string.
 *
 *   formatPrice(100, "USD", "en") === "$1"
 *   formatPrice(199, "USD", "en") === "$1.99"
 *   formatPrice(1000, "EUR", "de") === "10 €"
 *
 * `minimumFractionDigits` collapses to 0 when the amount is a whole unit so
 * `$1` shows instead of `$1.00`. Currencies that always show fractional units
 * (e.g. JPY) follow the locale's default.
 */
export function formatPrice(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/**
 * Format an access-duration in seconds as a human phrase, falling back
 * through minutes / hours / days. Returns the lifetime string when
 * `seconds <= 0` (matches the portal convention where absent / non-positive
 * durations mean "no expiry").
 */
export function formatDuration(seconds: number, t: TranslatorFn): string {
  if (seconds <= 0) return t("viewer.payment.lifetime");
  if (seconds < 3600) return t("viewer.payment.min", { n: Math.round(seconds / 60) });
  if (seconds < 86400) return t("viewer.payment.hr", { n: Math.round(seconds / 3600) });
  const days = Math.round(seconds / 86400);
  return t("viewer.payment.day", { n: days, count: days });
}
