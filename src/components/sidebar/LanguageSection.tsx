"use client";

import { useLocale } from "@/i18n/useLocale";
import type { Locale } from "@/i18n";

const LANGUAGES: { code: Locale; labelKey: string }[] = [
  { code: "en", labelKey: "viewer.sidebar.lang_en" },
  { code: "es", labelKey: "viewer.sidebar.lang_es" },
];

/** Language switcher rows — one button per supported locale. */
export default function LanguageSection() {
  const { t, locale, setLocale } = useLocale();
  return (
    <>
      <div
        className="mx-3 my-1 border-t"
        style={{ borderColor: "var(--theme-border)" }}
      />
      <div className="px-2 pb-3 pt-1">
        <div className="px-3 pb-1 pt-2">
          <span
            className="text-sm font-medium"
            style={{ color: "var(--theme-heading)" }}
          >
            {t("viewer.sidebar.language")}
          </span>
        </div>
        {LANGUAGES.map((lang) => (
          <button
            key={lang.code}
            onClick={() => setLocale(lang.code)}
            className={`flex w-full items-center gap-5 rounded-lg px-3 py-2 text-sm transition-colors ${
              locale === lang.code
                ? "bg-[var(--theme-bg-secondary)]"
                : "hover:bg-[var(--theme-bg-secondary)]"
            }`}
            style={{
              color: locale === lang.code ? "var(--theme-heading)" : "var(--theme-text)",
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ color: locale === lang.code ? "var(--theme-heading)" : "var(--theme-text-secondary)" }}
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <span className={locale === lang.code ? "font-medium" : ""}>
              {t(lang.labelKey)}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
