import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth-helpers";
import { getInstanceConfig } from "@/config/instance";
import AdminSidebar from "./AdminSidebar";
import LocaleProvider from "@/i18n/LocaleProvider";
import type { Locale } from "@/i18n";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Admin chrome palette. This is the PRODUCT's own surface (PrivaPaid Stream's
// back office), deliberately distinct from the operator's public storefront
// theme. `--theme-primary` is the PrivaPaid brand pink (#c9506b, the canonical
// accent shared with auth/theme.ts and the setup wizard) so every admin accent
// — buttons, links, active nav, focus rings, the wordmark — reads as one color.
// Previously primary was left unset, so accents fell back to the :root viewer
// default (#3ea6ff blue) and clashed with the pink wordmark.
const adminTheme = {
  "--theme-bg": "#ffffff",
  "--theme-bg-secondary": "#f4f4f5",
  "--theme-text": "#18181b",
  "--theme-text-secondary": "#71717a",
  "--theme-heading": "#09090b",
  "--theme-border": "#e4e4e7",
  "--theme-primary": "#c9506b",
} as React.CSSProperties;

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requireAdmin();
  const instanceConfig = await getInstanceConfig();
  const adminLocale = (instanceConfig.locale || "en") as Locale;

  return (
    <LocaleProvider locale={adminLocale}>
      {/* Token scope spans both sidebar and main so the rail shares the admin
          accent (active nav, focus rings) even though it keeps a dark palette. */}
      <div className="flex min-h-screen" style={adminTheme}>
        <AdminSidebar adminName={admin.name} adminRole={admin.role} />
        <main className="flex-1 bg-[var(--theme-bg)] p-6 text-[var(--theme-text)] lg:p-8">
          {children}
        </main>
      </div>
    </LocaleProvider>
  );
}
