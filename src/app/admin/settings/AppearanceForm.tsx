"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import ImageUpload from "@/components/ui/ImageUpload";
import Modal from "@/components/ui/Modal";
import { useLocale } from "@/i18n/useLocale";

interface AppearanceValues {
  instance_name: string;
  logo_url: string;
  logo_image_id: string;
  about_text: string;
  theme_primary: string;
  theme_bg: string;
  theme_bg_secondary: string;
  theme_text: string;
  theme_text_secondary: string;
  theme_heading: string;
  theme_border: string;
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
  theme_primary: "#3b82f6",
  theme_bg: "#0a0a0a",
  theme_bg_secondary: "#18181b",
  theme_text: "#ededed",
  theme_text_secondary: "#a1a1aa",
  theme_heading: "#fafafa",
  theme_border: "#27272a",
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

const COLOR_FIELDS: { key: keyof AppearanceValues; labelKey: string; descKey: string }[] = [
  { key: "theme_primary", labelKey: "admin.settings.color_primary", descKey: "admin.settings.color_primary_hint" },
  { key: "theme_bg", labelKey: "admin.settings.color_bg", descKey: "admin.settings.color_bg_hint" },
  { key: "theme_bg_secondary", labelKey: "admin.settings.color_surface", descKey: "admin.settings.color_surface_hint" },
  { key: "theme_text", labelKey: "admin.settings.color_text", descKey: "admin.settings.color_text_hint" },
  { key: "theme_text_secondary", labelKey: "admin.settings.color_muted", descKey: "admin.settings.color_muted_hint" },
  { key: "theme_heading", labelKey: "admin.settings.color_headings", descKey: "admin.settings.color_headings_hint" },
  { key: "theme_border", labelKey: "admin.settings.color_borders", descKey: "admin.settings.color_borders_hint" },
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
    <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
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
        <section>
          <h2 className="mb-4 text-lg font-semibold text-[var(--theme-text)]">{t("admin.settings.colors")}</h2>
          <div className="space-y-3 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-5">
            {COLOR_FIELDS.map(({ key, labelKey, descKey }) => (
              <div key={key} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--theme-text)]">{t(labelKey)}</p>
                  <p className="text-xs text-[var(--theme-text-secondary)]">{t(descKey)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={form[key] as string}
                    onChange={(e) => update(key, e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-[var(--theme-border)] bg-transparent p-0"
                  />
                  <input
                    type="text"
                    value={form[key] as string}
                    onChange={(e) => update(key, e.target.value)}
                    className="w-20 rounded border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] px-2 py-1 text-xs text-[var(--theme-text)] font-mono"
                    maxLength={7}
                  />
                </div>
              </div>
            ))}
          </div>
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
                className="text-[var(--theme-primary)] hover:underline"
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
                ? "border-green-500/20 bg-green-500/10 text-green-400"
                : "border-red-500/20 bg-red-500/10 text-red-400"
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
          <h2 className="mb-4 text-lg font-semibold text-red-500">Danger Zone</h2>
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-5">
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
                className="shrink-0 rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-500 transition-colors hover:bg-red-500/20"
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
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
            <p className="text-sm font-medium text-red-500">
              This will permanently delete all data:
            </p>
            <ul className="mt-2 space-y-1 text-xs text-red-400">
              <li>All channels and media files</li>
              <li>All products and encryption keys</li>
              <li>All comments</li>
              <li>All settings and configurations</li>
              <li>All uploaded images</li>
            </ul>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--theme-text)]">
              Type <span className="font-mono font-bold text-red-500">RESET</span> to confirm
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
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {resetting ? "Resetting..." : "Delete Everything"}
            </button>
          </div>
        </div>
      </Modal>

      {/* Live Preview */}
      <div className="lg:sticky lg:top-24">
        <h3 className="mb-3 text-sm font-medium text-[var(--theme-text-secondary)]">{t("admin.settings.preview")}</h3>
        <div
          className="overflow-hidden rounded-xl border shadow-lg"
          style={{
            backgroundColor: form.theme_bg,
            borderColor: form.theme_border,
            fontFamily: form.theme_font,
          }}
        >
          {/* Preview navbar */}
          <div
            className="flex items-center justify-between border-b px-4 py-3"
            style={{ borderColor: form.theme_border }}
          >
            <div className="flex items-center gap-2">
              {(form.logo_image_id || form.logo_url) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={form.logo_image_id ? `/api/images/${form.logo_image_id}` : form.logo_url}
                  alt=""
                  className="h-5 w-5 rounded object-contain"
                />
              ) : (
                <div
                  className="flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white"
                  style={{ backgroundColor: form.theme_primary }}
                >
                  {form.instance_name.charAt(0) || "M"}
                </div>
              )}
              <span
                className="text-sm font-semibold"
                style={{ color: form.theme_heading }}
              >
                {form.instance_name || "My Platform"}
              </span>
            </div>
            <span
              className="text-[10px] font-medium"
              style={{ color: form.theme_text_secondary }}
            >
              Log in
            </span>
          </div>

          {/* Preview content */}
          <div className="p-4 space-y-3">
            <h4
              className="text-base font-semibold"
              style={{ color: form.theme_heading }}
            >
              {t("admin.settings.preview_heading")}
            </h4>
            <p className="text-sm" style={{ color: form.theme_text }}>
              {t("admin.settings.preview_body")}
            </p>
            <p className="text-xs" style={{ color: form.theme_text_secondary }}>
              {t("admin.settings.preview_muted")}
            </p>

            {/* Preview card */}
            <div
              className="rounded-lg border p-3"
              style={{
                backgroundColor: form.theme_bg_secondary,
                borderColor: form.theme_border,
              }}
            >
              <p
                className="text-sm font-medium"
                style={{ color: form.theme_heading }}
              >
                {t("admin.settings.preview_card")}
              </p>
              <p
                className="mt-1 text-xs"
                style={{ color: form.theme_text_secondary }}
              >
                {t("admin.settings.preview_card_body")}
              </p>
              <div className="mt-2 flex gap-2">
                <span
                  className="rounded px-2 py-0.5 text-[10px] font-medium text-white"
                  style={{ backgroundColor: form.theme_primary }}
                >
                  {t("admin.settings.preview_badge")}
                </span>
                <span
                  className="rounded px-2 py-0.5 text-[10px]"
                  style={{
                    backgroundColor: form.theme_bg,
                    color: form.theme_text_secondary,
                    border: `1px solid ${form.theme_border}`,
                  }}
                >
                  {t("admin.settings.preview_comments")}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
