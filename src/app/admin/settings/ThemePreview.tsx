"use client";

import { useState } from "react";
import { themeStyles, type ThemeConfig } from "@/config/theme";
import { useLocale } from "@/i18n/useLocale";
import CategoryChips from "@/components/CategoryChips";
import ProductButtons from "@/components/paywall/ProductButtons";

export default function ThemePreview({ theme, name, className = "", showHeading = true }: { theme: ThemeConfig; name: string; className?: string; showHeading?: boolean }) {
  const { t } = useLocale();
  const [view, setView] = useState("home");
  return (
    <div className={`self-start lg:sticky lg:top-24 ${className}`}>
      {showHeading && <h3 className="mb-3 text-sm font-medium text-[var(--theme-text-secondary)]">{t("admin.settings.preview")}</h3>}
      <div className="mb-3 flex gap-2" role="group" aria-label={t("admin.settings.preview")}>
        {["home", "video"].map((tab) => (
          <button key={tab} type="button" aria-pressed={view === tab} onClick={() => setView(tab)}
            className={`min-h-11 flex-1 rounded-lg border border-[var(--theme-border)] px-3 text-sm ${view === tab ? "bg-[var(--theme-primary)] text-[var(--theme-primary-text)]" : "hover:bg-[var(--theme-hover)]"}`}>
            {t(`admin.settings.preview_${tab}`)}
          </button>
        ))}
      </div>
      <div data-testid="theme-preview" style={{ ...themeStyles(theme), fontFamily: `${JSON.stringify(theme.font)}, var(--font-sans), Arial, sans-serif` }} className="overflow-hidden rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] text-[var(--theme-text)] shadow-lg">
        <div className="flex items-center gap-3 border-b border-[var(--theme-border)] bg-[var(--theme-nav-bg)] p-4 text-[var(--theme-nav-text)]">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M2 12h12v1H2zm0-4h12v1H2zm0-4h12v1H2z" /></svg>
          {theme.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={theme.logo} alt="" className="h-7 max-w-20 shrink-0 object-contain" />
          ) : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--theme-primary)] text-sm font-bold text-[var(--theme-primary-text)]">{name.charAt(0) || "M"}</span>}
          <span className="truncate text-sm font-semibold">{name || "My Platform"}</span>
        </div>
        <div className="space-y-4 p-4">
          {view === "home" ? <>
            <CategoryChips categories={[{ _id: "preview", name: t("admin.settings.preview_video") }]} activeCategory={null} onSelect={() => setView("video")} />
            <div className="relative flex aspect-video items-center justify-center rounded-lg bg-[var(--theme-media-bg)] text-[var(--theme-media-text)]">
              <svg aria-hidden="true" width="40" height="40" viewBox="0 0 16 16" fill="currentColor"><path d="M6.79 5.093A.5.5 0 0 0 6 5.5v5a.5.5 0 0 0 .79.407l3.5-2.5a.5.5 0 0 0 0-.814z" /></svg>
              <span className="absolute bottom-2 right-2 rounded bg-[var(--theme-media-bg)]/90 px-2 py-1 text-xs">12:48</span>
              <span className="absolute bottom-2 left-2 rounded bg-[var(--theme-primary)] px-2 py-1 text-xs text-[var(--theme-primary-text)]">$2.00</span>
            </div>
            <h4 className="text-base font-semibold">{t("admin.settings.preview_heading")}</h4>
            <p className="text-xs text-[var(--theme-text-secondary)]">{name} · {t("admin.settings.preview_muted")}</p>
            <div className="rounded-lg bg-[var(--theme-hover)] p-3 text-sm">{t("admin.settings.preview_hover")}</div>
          </> : <>
            <div className="rounded-lg bg-[var(--theme-media-bg)] px-3 py-6 text-[var(--theme-media-text)]">
              <ProductButtons products={[{ productId: "preview", encryptedBlob: "", name: t("admin.settings.preview_video"), priceCents: 200, currency: "USD", accessDurationSeconds: 86400 }]} loading={false} onUnlock={() => {}} onOpenExchangeGuide={() => {}} />
            </div>
            <h4 className="text-base font-semibold">{t("admin.settings.preview_heading")}</h4>
            <div className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-3 text-sm">{t("admin.settings.preview_body")}</div>
          </>}
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded bg-[var(--theme-success)]/15 px-2 py-1 text-[var(--theme-success)]">{t("admin.settings.color_success")}</span>
            <span className="rounded bg-[var(--theme-warning)]/15 px-2 py-1 text-[var(--theme-warning)]">{t("admin.settings.color_warning")}</span>
            <span className="rounded bg-[var(--theme-error)]/15 px-2 py-1 text-[var(--theme-error)]">{t("admin.settings.color_error")}</span>
          </div>
        </div>
      </div>
      <p className="mt-3 text-xs text-[var(--theme-text-secondary)]">{t("admin.settings.preview_hint")}</p>
    </div>
  );
}
