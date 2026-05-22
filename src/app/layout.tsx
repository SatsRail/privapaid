import type { Metadata } from "next";
import Script from "next/script";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import SessionProvider from "@/components/SessionProvider";
import { SidebarProvider } from "@/components/SidebarContext";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import AgeGate from "@/components/AgeGate";
import LocaleProvider from "@/i18n/LocaleProvider";
import { getInstanceConfig } from "@/config/instance";
import type { Locale } from "@/i18n";
import "./globals.css";

export const dynamic = "force-dynamic";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const instanceConfig = await getInstanceConfig();
  const siteUrl = `https://${instanceConfig.domain}`;

  return {
    metadataBase: new URL(siteUrl),
    title: {
      template: `%s — ${instanceConfig.name}`,
      default: instanceConfig.name,
    },
    description: instanceConfig.aboutText || `${instanceConfig.name} — powered by PrivaPaid`,
    openGraph: {
      siteName: instanceConfig.name,
      type: "website",
      locale: instanceConfig.locale === "es" ? "es_ES" : "en_US",
      ...(instanceConfig.theme.logo && {
        images: [{ url: instanceConfig.theme.logo }],
      }),
    },
    twitter: {
      card: "summary",
    },
    icons: {
      icon: instanceConfig.theme.logo ? "/api/favicon" : "/favicon.ico",
      apple: instanceConfig.theme.logo ? "/api/favicon/apple" : "/favicon.ico",
    },
    ...(instanceConfig.googleSiteVerification && {
      verification: {
        google: instanceConfig.googleSiteVerification,
      },
    }),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const instanceConfig = await getInstanceConfig();
  const { theme } = instanceConfig;

  // Viewer locale: cookie → fallback to "en"
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
  const viewerLocale: Locale =
    cookieLocale === "es" ? "es" : "en";

  const themeVars = {
    "--theme-primary": theme.primary,
    "--theme-bg": theme.bg,
    "--theme-bg-secondary": theme.bgSecondary,
    "--theme-text": theme.text,
    "--theme-text-secondary": theme.textSecondary,
    "--theme-heading": theme.heading,
    "--theme-border": theme.border,
  } as React.CSSProperties;

  const gaId = instanceConfig.googleAnalyticsId;

  return (
    <html lang={viewerLocale} className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        style={themeVars}
      >
        {/*
          Public-safe runtime config emitted before any other script runs.
          Lets sentry.client.config.ts pick up a DB-backed Sentry DSN
          (configured via /admin/settings) without a Docker rebuild.
          Only include public-safe values here — never secrets.
        */}
        <Script id="instance-config" strategy="beforeInteractive">
          {`window.__INSTANCE_CONFIG__=${JSON.stringify({
            sentryDsn: instanceConfig.sentryDsn || "",
          })};`}
        </Script>
        {gaId && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
              strategy="afterInteractive"
            />
            <Script id="google-analytics" strategy="afterInteractive">
              {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${gaId}');`}
            </Script>
          </>
        )}
        <SessionProvider>
          <LocaleProvider locale={viewerLocale} allowSwitch>
            {instanceConfig.nsfw && (
              <AgeGate disclaimer={instanceConfig.adultDisclaimer} />
            )}
            <SidebarProvider>
              <Navbar
                instanceName={instanceConfig.name}
                logoUrl={theme.logo}
                aboutText={instanceConfig.aboutText}
              />
              {children}
              <Footer />
            </SidebarProvider>
          </LocaleProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
