import { prisma } from "@/lib/prisma";
export interface ThemeConfig {
  primary: string;
  bg: string;
  bgSecondary: string;
  text: string;
  textSecondary: string;
  heading: string;
  border: string;
  font: string;
  logo: string;
}

export interface InstanceConfig {
  name: string;
  domain: string;
  nsfw: boolean;
  adultDisclaimer: string;
  aboutText: string;
  locale: string;
  currency: string;
  theme: ThemeConfig;
  satsrail: {
    apiUrl: string;
  };
  googleAnalyticsId: string;
  googleSiteVerification: string;
  sentryDsn: string;
}

const DEFAULT_THEME: ThemeConfig = {
  primary: "#3b82f6",
  bg: "#0a0a0a",
  bgSecondary: "#18181b",
  text: "#ededed",
  textSecondary: "#a1a1aa",
  heading: "#fafafa",
  border: "#27272a",
  font: "Geist",
  logo: "",
};

/**
 * SatsRail's merchant API is served from `app.satsrail.com`. Earlier example
 * env files shipped `https://satsrail.com/api/v1`, but the bare apex has no
 * DNS record at all, so every request against it fails to resolve before it
 * ever leaves the box. Downstream that surfaced as a misleading "Product not
 * found on SatsRail", because the callers could not tell a dead hostname from
 * a genuine 404.
 *
 * Rewrite the two marketing hostnames onto the API host and supply the
 * `/api/v1` prefix when the URL carries no path. Custom or self-hosted portal
 * URLs are left exactly as configured.
 */
const SATSRAIL_API_HOST = "app.satsrail.com";
const LEGACY_SATSRAIL_HOSTS = new Set(["satsrail.com", "www.satsrail.com"]);

export const DEFAULT_SATSRAIL_API_URL = `https://${SATSRAIL_API_HOST}/api/v1`;

export function normalizeSatsRailApiUrl(raw?: string | null): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_SATSRAIL_API_URL;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return DEFAULT_SATSRAIL_API_URL;
  }

  if (LEGACY_SATSRAIL_HOSTS.has(url.hostname.toLowerCase())) {
    url.hostname = SATSRAIL_API_HOST;
  }

  // Drop any trailing slash; a bare origin gets the versioned API prefix.
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path === "" ? "/api/v1" : path;

  return `${url.origin}${url.pathname}`;
}

// Synchronous fallback using env vars (used at build time and as defaults)
const config: InstanceConfig = {
  name: process.env.INSTANCE_NAME || "Media Platform",
  domain: process.env.INSTANCE_DOMAIN || "localhost:3000",
  nsfw: process.env.NSFW_ENABLED === "true",
  adultDisclaimer: "",
  aboutText: "",
  locale: "en",
  currency: "USD",
  theme: {
    ...DEFAULT_THEME,
    primary: process.env.THEME_PRIMARY || DEFAULT_THEME.primary,
    logo: process.env.LOGO_URL || DEFAULT_THEME.logo,
  },
  satsrail: {
    apiUrl: normalizeSatsRailApiUrl(process.env.SATSRAIL_API_URL),
  },
  googleAnalyticsId: process.env.GOOGLE_ANALYTICS_ID || "",
  googleSiteVerification: process.env.GOOGLE_SITE_VERIFICATION || "",
  sentryDsn: process.env.SENTRY_DSN || "",
};

export default config;

export { DEFAULT_THEME };

// Async version that reads from Postgres on every request (no caching).
// All pages use force-dynamic, so fresh reads are expected.
export async function getInstanceConfig(): Promise<InstanceConfig> {
  try {
    const settings = await prisma.settings.findFirst({
      where: { setupCompleted: true },
    });
    if (settings) {
      return {
        name: settings.instanceName || config.name,
        domain: settings.instanceDomain || config.domain,
        nsfw: settings.nsfwEnabled ?? config.nsfw,
        adultDisclaimer: settings.adultDisclaimer || "",
        aboutText: settings.aboutText || "",
        locale: settings.merchantLocale || "en",
        currency: settings.merchantCurrency || "USD",
        theme: {
          primary: settings.themePrimary || DEFAULT_THEME.primary,
          bg: settings.themeBg || DEFAULT_THEME.bg,
          bgSecondary: settings.themeBgSecondary || DEFAULT_THEME.bgSecondary,
          text: settings.themeText || DEFAULT_THEME.text,
          textSecondary: settings.themeTextSecondary || DEFAULT_THEME.textSecondary,
          heading: settings.themeHeading || DEFAULT_THEME.heading,
          border: settings.themeBorder || DEFAULT_THEME.border,
          font: settings.themeFont || DEFAULT_THEME.font,
          logo: settings.logoBytes
            ? `/api/images/logo`
            : settings.logoUrl || DEFAULT_THEME.logo,
        },
        satsrail: {
          apiUrl: settings.satsrailApiUrl
            ? normalizeSatsRailApiUrl(settings.satsrailApiUrl)
            : config.satsrail.apiUrl,
        },
        googleAnalyticsId: settings.googleAnalyticsId || config.googleAnalyticsId,
        googleSiteVerification: settings.googleSiteVerification || config.googleSiteVerification,
        sentryDsn: settings.sentryDsn || config.sentryDsn,
      };
    }
  } catch {
    // Fall back to env vars if DB is unavailable
  }

  return config;
}

// No-op: caching was removed but callers still reference this.
export function clearConfigCache(): void {
  /* intentional no-op */
}
