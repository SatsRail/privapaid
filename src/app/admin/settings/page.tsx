import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth-helpers";
import AppearanceForm from "./AppearanceForm";
import { colorsFromSettings } from "@/config/theme";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requireOwner();

  const settings = await prisma.settings.findFirst({
    where: { setupCompleted: true },
    select: {
      instanceName: true,
      logoUrl: true,
      logoBytes: true,
      aboutText: true,
      nsfwEnabled: true,
      themePrimary: true,
      themeBg: true,
      themeBgSecondary: true,
      themeText: true,
      themeTextSecondary: true,
      themeHeading: true,
      themeBorder: true,
      themePrimaryText: true,
      themeLink: true,
      themeNavBg: true,
      themeNavText: true,
      themeHover: true,
      themeMediaBg: true,
      themeMediaText: true,
      themeSuccess: true,
      themeWarning: true,
      themeError: true,
      themeFont: true,
      googleAnalyticsId: true,
      googleSiteVerification: true,
      sentryDsn: true,
    },
  });

  if (!settings) {
    return (
      <div className="py-16 text-center text-[var(--theme-text-secondary)]">
        <p>Settings not found. Complete setup first.</p>
      </div>
    );
  }

  // Serialize for client component. The presence of logoBytes is signalled
  // via the logo route URL — there's only ever one logo (Settings is a
  // singleton), so we use a fixed marker to indicate "uploaded bytes exist".
  const initialValues = {
    instance_name: settings.instanceName || "",
    logo_url: settings.logoUrl || "",
    logo_image_id: settings.logoBytes ? "logo" : "",
    about_text: settings.aboutText || "",
    ...colorsFromSettings(settings),
    theme_font: settings.themeFont || "Geist",
    google_analytics_id: settings.googleAnalyticsId || "",
    google_site_verification: settings.googleSiteVerification || "",
    sentry_dsn: settings.sentryDsn || "",
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Appearance</h1>
        <p className="mt-1 text-sm text-[var(--theme-text-secondary)]">
          Customize the look and feel of your site
        </p>
      </div>
      <AppearanceForm initialValues={initialValues} />
    </div>
  );
}
