/**
 * Tiny relative-time formatter. YouTube-style ("3 days ago", "2 weeks ago").
 *
 * Uses the browser/server's `Intl.RelativeTimeFormat` so output is properly
 * localized for the viewer's locale. Falls back to English if the locale
 * isn't supported by the runtime.
 *
 * Buckets:
 *   < 60s        → "just now"
 *   < 60m        → "N minutes ago"
 *   < 24h        → "N hours ago"
 *   < 7d         → "N days ago"
 *   < ~30d       → "N weeks ago"
 *   < ~365d      → "N months ago"
 *   ≥ 1y         → "N years ago"
 *
 * Edge cases:
 *   - future timestamps render normally ("in 3 hours") — should be rare in
 *     practice (clock drift only) so we don't bother special-casing.
 *   - invalid/missing inputs return an empty string rather than throwing.
 */
export function formatTimeAgo(input: string | Date | undefined | null, locale = "en"): string {
  if (!input) return "";
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) return "";

  const diffSec = Math.round((date.getTime() - Date.now()) / 1000);
  const absSec = Math.abs(diffSec);

  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (absSec < 60) {
    value = diffSec;
    unit = "second";
  } else if (absSec < 3600) {
    value = Math.round(diffSec / 60);
    unit = "minute";
  } else if (absSec < 86400) {
    value = Math.round(diffSec / 3600);
    unit = "hour";
  } else if (absSec < 604800) {
    value = Math.round(diffSec / 86400);
    unit = "day";
  } else if (absSec < 2629800) {
    // ~30.44 days = average month length
    value = Math.round(diffSec / 604800);
    unit = "week";
  } else if (absSec < 31557600) {
    // 365.25 days = average year length
    value = Math.round(diffSec / 2629800);
    unit = "month";
  } else {
    value = Math.round(diffSec / 31557600);
    unit = "year";
  }

  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    return rtf.format(value, unit);
  } catch {
    // Locale not supported by Intl — fall back to English.
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    return rtf.format(value, unit);
  }
}
