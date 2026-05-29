import en from "./en.json";
import es from "./es.json";

type TranslationDict = Record<string, string>;

const dictionaries: Record<string, TranslationDict> = { en, es };

export type Locale = "en" | "es";

export const SUPPORTED_LOCALES: Locale[] = ["en", "es"];

/**
 * Translate a key to the given locale.
 * Supports simple interpolation: t("en", "greeting", { name: "John" })
 * Supports pluralization: t("en", "comments", { count: 3 })
 *   Looks up "comments_zero", "comments_one", "comments_other" based on count.
 * Falls back to the key itself if not found.
 */
export function t(
  locale: string,
  key: string,
  params?: Record<string, string | number>
): string {
  const dict = dictionaries[locale] || dictionaries.en;
  const fallback = dictionaries.en;

  let value: string | undefined;

  // Pluralization: if params.count exists, look for _zero, _one, _other variants
  if (params && typeof params.count === "number") {
    const count = params.count;
    const pluralKey =
      count === 0
        ? `${key}_zero`
        : count === 1
          ? `${key}_one`
          : `${key}_other`;

    value = dict[pluralKey] ?? fallback[pluralKey] ?? dict[key] ?? fallback[key];
  } else {
    value = dict[key] ?? fallback[key];
  }

  if (!value) return key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      // Numbers render with locale grouping ("12,480" / "12.480") so large
      // counts read as polished rather than as a raw digit run.
      const rendered = typeof v === "number" ? v.toLocaleString(locale) : String(v);
      value = value.replace(`{${k}}`, rendered);
    }
  }

  return value;
}

/**
 * Create a bound translator for a specific locale.
 * Usage: const t = createTranslator("es"); t("admin.sidebar.dashboard");
 */
export function createTranslator(locale: string) {
  return (key: string, params?: Record<string, string | number>) =>
    t(locale, key, params);
}

export type TranslatorFn = ReturnType<typeof createTranslator>;
