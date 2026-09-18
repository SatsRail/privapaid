"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import ImageUpload from "@/components/ui/ImageUpload";
import Modal from "@/components/ui/Modal";
import { useLocale } from "@/i18n/useLocale";
import { COLOR_FIELDS, colorsFromSettings, contrastRatio, isHexColor, resolveTheme, themeFromColors, type ThemeColorValues } from "@/config/theme";
import ThemePreview from "./ThemePreview";

interface AppearanceValues extends ThemeColorValues {
  instance_name: string;
  logo_url: string;
  logo_image_id: string;
  about_text: string;
  theme_font: string;
  google_analytics_id: string;
  google_site_verification: string;
  sentry_dsn: string;
}

const DEFAULTS: AppearanceValues = {
  instance_name: "",
  logo_url: "",
  logo_image_id: "",
  about_text: "",
  ...colorsFromSettings({}),
  theme_font: "Geist",
  google_analytics_id: "",
  google_site_verification: "",
  sentry_dsn: "",
};

const FONTS = [
  "Geist",
  "Inter",
  "DM Sans",
  "Plus Jakarta Sans",
  "Space Grotesk",
  "Outfit",
  "Poppins",
  "Nunito",
  "system-ui",
  "Georgia",
];

interface AppearanceFormProps {
  initialValues: AppearanceValues;
}

export default function AppearanceForm({ initialValues }: AppearanceFormProps) {
  const { t } = useLocale();
  const router = useRouter();
  const [form, setForm] = useState<AppearanceValues>(initialValues);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetting, setResetting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const theme = {
    ...themeFromColors(form, form.theme_font),
    logo: form.logo_image_id ? `/api/images/${form.logo_image_id}` : form.logo_url,
  };
  const palette = resolveTheme(theme);
  const invalidColors = COLOR_FIELDS.filter(({ key, group }) => !isHexColor(form[key]) && (group === "base" || form[key] !== ""));
  const contrastWarnings = [
    { label: "text", fg: palette.text, bg: palette.bg },
    { label: "muted", fg: palette.textSecondary, bg: palette.bg },
    { label: "primary_text", fg: palette.primaryText, bg: palette.primary },
    { label: "link", fg: palette.link, bg: palette.bg },
    { label: "link", fg: palette.link, bg: palette.bgSecondary },
    { label: "nav_text", fg: palette.navText, bg: palette.navBg },
    { label: "media_text", fg: palette.mediaText, bg: palette.mediaBg },
  ].filter(({ fg, bg }) => contrastRatio(fg, bg) < 4.5);

  function update<K extends keyof AppearanceValues>(key: K, value: AppearanceValues[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setMessage(null);
  }

  function resetToDefaults() {
    setForm({
      ...DEFAULTS,
      instance_name: form.instance_name, // Keep the name
      logo_url: form.logo_url, // Keep the logo
      logo_image_id: form.logo_image_id, // Keep the logo
      about_text: form.about_text, // Keep the about text
      google_analytics_id: form.google_analytics_id, // Keep GA config
      google_site_verification: form.google_site_verification,
      sentry_dsn: form.sentry_dsn, // Keep error reporting config
    });
    setMessage(null);
  }

  async function handleSave() {
    if (invalidColors.length) {
      setMessage({ type: "error", text: t("admin.settings.invalid_color") });
      return;
    }
    if (!form.instance_name.trim()) {
      setMessage({ type: "error", text: t("admin.settings.name_required") });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        setMessage({ type: "error", text: data.error || t("admin.settings.save_failed") });
        return;
      }

      setMessage({ type: "success", text: t("admin.settings.saved") });
      router.refresh();
    } catch {
      setMessage({ type: "error", text: t("admin.settings.error") });
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/settings/sync", { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "Sync failed" });
        return;
      }

      if (data.logo_url !== undefined) {
        update("logo_url", data.logo_url);
      }
      setMessage({ type: "success", text: "Synced merchant data from SatsRail" });
      router.refresh();
    } catch {
      setMessage({ type: "error", text: "Failed to sync merchant data" });
    } finally {
      setSyncing(false);
    }
  }

  async function handleFactoryReset() {
    setResetting(true);
    try {
      const res = await fetch("/api/admin/settings/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "RESET" }),
      });

      if (!res.ok) {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Reset failed" });
        return;
      }

      // Redirect to setup page after successful reset
      window.location.href = "/setup";
    } catch {
      setMessage({ type: "error", text: "Failed to reset application" });
    } finally {
      setResetting(false);
      setShowResetModal(false);
      setResetConfirm("");
    }
  }

  return (
    <div className="grid items-start gap-8 pb-20 lg:grid-cols-[minmax(0,1fr)_320px] lg:pb-0 xl:grid-cols-[minmax(0,1fr)_360px]">
      {/* Form */}
      <div className="space-y-8">
        {/* Identity */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-[var(--theme-text)]">{t("admin.settings.identity")}</h2>
          <div className="space-y-4 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-5">
            <Input
              label={t("admin.settings.instance_name")}
              type="text"
              value={form.instance_name}
              onChange={(e) => update("instance_name", e.target.value)}
              placeholder={t("admin.settings.instance_name_placeholder")}
              required
            />
            <ImageUpload
              context="site_logo"
              currentImageId={form.logo_image_id}
              currentImageUrl={form.logo_url}
              onUpload={(id) => update("logo_image_id", id)}
              label={t("admin.settings.logo")}
            />
            <button
              type="button"
              onClick={handleSync}
              disabled={syncing}
              className="flex items-center gap-1.5 rounded-lg border border-[var(--theme-border)] px-3 py-1.5 text-xs font-medium text-[var(--theme-text-secondary)] transition-colors hover:bg-[var(--theme-bg)] disabled:opacity-50"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={syncing ? "animate-spin" : ""}>
                <path d="M21 2v6h-6" />
                <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                <path d="M3 22v-6h6" />
                <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              </svg>
              {syncing ? "Syncing..." : "Sync from SatsRail"}
            </button>
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--theme-text)]">
                {t("admin.settings.about")}
              </label>
              <textarea
                value={form.about_text}
                onChange={(e) => update("about_text", e.target.value)}
                placeholder={t("admin.settings.about_placeholder")}
                rows={3}
                maxLength={500}
                className="w-full rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm text-[var(--theme-text)] placeholder:text-[var(--theme-text-secondary)]"
              />
              <p className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                {t("admin.settings.about_hint")} {form.about_text.length}/500
              </p>
            </div>
          </div>
        </section>

        {/* Colors */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-[var(--theme-text)]">{t("admin.settings.colors")}</h2>
          <p className="text-sm text-[var(--theme-text-secondary)]">{t("admin.settings.colors_hint")}</p>
          {(["base", "navigation", "media", "status"] as const).map((group) => (
            <fieldset key={group} className="min-w-0 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] px-4 pb-2">
              <legend className="px-1 text-sm font-semibold">{t(`admin.settings.group_${group}`)}</legend>
              {COLOR_FIELDS.filter((field) => field.group === group).map(({ key, token, label }) => {
                const invalid = invalidColors.some((field) => field.key === key);
                return (
                  <div key={key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--theme-border)] py-4 last:border-0">
                    <div className="min-w-0 flex-1 basis-40">
                      <label htmlFor={key} className="text-sm font-medium text-[var(--theme-text)]">{t(`admin.settings.color_${label}`)}</label>
                      <p id={`${key}-hint`} className="mt-0.5 text-xs text-[var(--theme-text-secondary)]">{t(`admin.settings.color_${label}_hint`)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <input type="color" id={key} aria-describedby={`${key}-hint`}
                        value={palette[token]} onChange={(e) => update(key, e.target.value)}
                        className="h-11 w-11 cursor-pointer rounded-lg border border-[var(--theme-border)] bg-transparent p-1" />
                      <input type="text" aria-label={`${t(`admin.settings.color_${label}`)} — HEX`}
                        aria-invalid={invalid} aria-describedby={invalid ? "theme-color-error" : `${key}-hint`}
                        value={form[key]} placeholder={palette[token]} onChange={(e) => update(key, e.target.value)}
                        className="h-11 w-24 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2 font-mono text-xs text-[var(--theme-text)] placeholder:text-[var(--theme-text-secondary)]"
                        maxLength={7} spellCheck={false} />
                      {group !== "base" && (
                        <button type="button" onClick={() => update(key, "")}
                          aria-label={t("admin.settings.use_auto", { color: t(`admin.settings.color_${label}`) })}
                          aria-pressed={form[key] === ""}
                          className={`min-h-11 rounded-lg px-2 text-xs ${form[key] === "" ? "bg-[var(--theme-primary)]/15 text-[var(--theme-link)]" : "text-[var(--theme-text-secondary)] hover:bg-[var(--theme-hover)]"}`}>
                          {t("admin.settings.auto")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </fieldset>
          ))}
          {invalidColors.length > 0 && <p id="theme-color-error" role="alert" className="text-sm text-[var(--theme-error)]">{t("admin.settings.invalid_color")}</p>}
          {contrastWarnings.length > 0 && <p role="status" className="rounded-lg border border-[var(--theme-border)] p-3 text-sm text-[var(--theme-text-secondary)]">
            {t("admin.settings.contrast_hint", { colors: [...new Set(contrastWarnings.map(({ label }) => t(`admin.settings.color_${label}`)))].join(", ") })}
          </p>}
        </section>

        {/* Typography */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-[var(--theme-text)]">{t("admin.settings.typography")}</h2>
          <div className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-5">
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--theme-text)]">
                {t("admin.settings.font_family")}
              </label>
              <select
                value={form.theme_font}
                onChange={(e) => update("theme_font", e.target.value)}
                className="w-full rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] px-3 py-2 text-sm text-[var(--theme-text)]"
              >
                {FONTS.map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* SEO & Analytics */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-[var(--theme-text)]">SEO &amp; Analytics</h2>
          <div className="space-y-4 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-5">
            <Input
              label="Google Analytics ID"
              type="text"
              value={form.google_analytics_id}
              onChange={(e) => update("google_analytics_id", e.target.value)}
              placeholder="G-XXXXXXXXXX"
            />
            <Input
              label="Google Site Verification"
              type="text"
              value={form.google_site_verification}
              onChange={(e) => update("google_site_verification", e.target.value)}
              placeholder="Verification meta tag content"
            />
          </div>
        </section>

        {/* Error Reporting */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-[var(--theme-text)]">Error Reporting</h2>
          <div className="space-y-4 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-5">
            <Input
              label="Sentry DSN"
              type="text"
              value={form.sentry_dsn}
              onChange={(e) => update("sentry_dsn", e.target.value)}
              placeholder="https://abc123@o123456.ingest.sentry.io/456789"
            />
            <p className="text-xs text-[var(--theme-text-secondary)]">
              Paste your Sentry DSN to enable automatic error reporting. Get one free at{" "}
              <a
                href="https://sentry.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--theme-link)] hover:underline"
              >
                sentry.io
              </a>
              . Leave blank to disable.
            </p>
          </div>
        </section>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <Button type="button" onClick={handleSave} loading={saving}>
            {t("admin.settings.save")}
          </Button>
          <Button type="button" variant="secondary" onClick={resetToDefaults}>
            {t("admin.settings.reset_colors")}
          </Button>
        </div>

        {message && (
          <div
            className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium ${
              message.type === "success"
                ? "border-[var(--theme-success)]/20 bg-[var(--theme-success)]/10 text-[var(--theme-success)]"
                : "border-[var(--theme-error)]/20 bg-[var(--theme-error)]/10 text-[var(--theme-error)]"
            }`}
          >
            {message.type === "success" ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M8 5v3.5M8 10.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            )}
            {message.text}
          </div>
        )}
        {/* Danger Zone */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-[var(--theme-error)]">Danger Zone</h2>
          <div className="rounded-lg border border-[var(--theme-error)]/30 bg-[var(--theme-error)]/5 p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-[var(--theme-text)]">Factory Reset</p>
                <p className="text-xs text-[var(--theme-text-secondary)]">
                  Permanently delete all data including channels, media, products, and settings.
                  This cannot be undone.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowResetModal(true)}
                className="shrink-0 rounded-lg border border-[var(--theme-error)]/50 bg-[var(--theme-error)]/10 px-4 py-2 text-sm font-medium text-[var(--theme-error)] transition-colors hover:bg-[var(--theme-error)]/20"
              >
                Reset App
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Factory Reset Confirmation Modal */}
      <Modal
        open={showResetModal}
        onClose={() => {
          setShowResetModal(false);
          setResetConfirm("");
        }}
        title="Factory Reset"
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-[var(--theme-error)]/30 bg-[var(--theme-error)]/10 p-3">
            <p className="text-sm font-medium text-[var(--theme-error)]">
              This will permanently delete all data:
            </p>
            <ul className="mt-2 space-y-1 text-xs text-[var(--theme-error)]">
              <li>All channels and media files</li>
              <li>All products and encryption keys</li>
              <li>All comments</li>
              <li>All settings and configurations</li>
              <li>All uploaded images</li>
            </ul>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--theme-text)]">
              Type <span className="font-mono font-bold text-[var(--theme-error)]">RESET</span> to confirm
            </label>
            <input
              type="text"
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
              placeholder="RESET"
              className="w-full rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm text-[var(--theme-text)] placeholder:text-[var(--theme-text-secondary)]"
              autoComplete="off"
            />
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                setShowResetModal(false);
                setResetConfirm("");
              }}
              className="rounded-lg border border-[var(--theme-border)] px-4 py-2 text-sm font-medium text-[var(--theme-text-secondary)] transition-colors hover:bg-[var(--theme-bg-secondary)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleFactoryReset}
              disabled={resetConfirm !== "RESET" || resetting}
              className="rounded-lg bg-[var(--theme-error)] px-4 py-2 text-sm font-medium text-[var(--theme-error-text)] transition-colors hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {resetting ? "Resetting..." : "Delete Everything"}
            </button>
          </div>
        </div>
      </Modal>

      <ThemePreview theme={theme} name={form.instance_name} className="hidden lg:block" />
      <button type="button" onClick={() => setShowPreview(true)} className="fixed bottom-4 right-4 z-40 min-h-11 rounded-full bg-[var(--theme-primary)] px-5 text-sm font-semibold text-[var(--theme-primary-text)] shadow-lg lg:hidden">
        {t("admin.settings.preview")}
      </button>
      <Modal open={showPreview} onClose={() => setShowPreview(false)} title={t("admin.settings.preview")}>
        <ThemePreview theme={theme} name={form.instance_name} showHeading={false} />
      </Modal>
    </div>
  );
}
