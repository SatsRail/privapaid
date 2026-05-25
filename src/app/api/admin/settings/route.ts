import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { clearConfigCache } from "@/config/instance";
import { audit } from "@/lib/audit";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const SETTINGS_SELECT = {
  instanceName: true,
  logoUrl: true,
  aboutText: true,
  nsfwEnabled: true,
  adultDisclaimer: true,
  themePrimary: true,
  themeBg: true,
  themeBgSecondary: true,
  themeText: true,
  themeTextSecondary: true,
  themeHeading: true,
  themeBorder: true,
  themeFont: true,
  googleAnalyticsId: true,
  googleSiteVerification: true,
  sentryDsn: true,
} as const;

// Map Prisma's camelCase row to the snake_case API contract the admin UI
// (and existing tests) consume. The DB is the new shape; the wire stays old.
function serializeSettings(s: Record<string, unknown>): Record<string, unknown> {
  return {
    instance_name: s.instanceName,
    logo_url: s.logoUrl,
    about_text: s.aboutText,
    nsfw_enabled: s.nsfwEnabled,
    adult_disclaimer: s.adultDisclaimer,
    theme_primary: s.themePrimary,
    theme_bg: s.themeBg,
    theme_bg_secondary: s.themeBgSecondary,
    theme_text: s.themeText,
    theme_text_secondary: s.themeTextSecondary,
    theme_heading: s.themeHeading,
    theme_border: s.themeBorder,
    theme_font: s.themeFont,
    google_analytics_id: s.googleAnalyticsId,
    google_site_verification: s.googleSiteVerification,
    sentry_dsn: s.sentryDsn,
  };
}

export async function GET() {
  const authResult = await requireOwnerApi();
  if (authResult instanceof NextResponse) return authResult;

  const settings = await prisma.settings.findFirst({
    where: { setupCompleted: true },
    select: SETTINGS_SELECT,
  });

  if (!settings) {
    return NextResponse.json({ error: "Settings not found" }, { status: 404 });
  }

  return NextResponse.json({ settings: serializeSettings(settings) });
}

export async function PUT(request: Request) {
  const authResult = await requireOwnerApi();
  if (authResult instanceof NextResponse) return authResult;

  try {
    const validated = await validateBody(request, schemas.settingsUpdate);
    if (isValidationError(validated)) return validated;

    // Map snake_case schema keys to camelCase Prisma fields.
    const fieldMap: Record<string, string> = {
      instance_name: "instanceName",
      logo_url: "logoUrl",
      about_text: "aboutText",
      nsfw_enabled: "nsfwEnabled",
      adult_disclaimer: "adultDisclaimer",
      theme_primary: "themePrimary",
      theme_bg: "themeBg",
      theme_bg_secondary: "themeBgSecondary",
      theme_text: "themeText",
      theme_text_secondary: "themeTextSecondary",
      theme_heading: "themeHeading",
      theme_border: "themeBorder",
      theme_font: "themeFont",
      google_analytics_id: "googleAnalyticsId",
      google_site_verification: "googleSiteVerification",
      sentry_dsn: "sentryDsn",
    };

    const updates: Prisma.SettingsUpdateInput = {};
    for (const [key, value] of Object.entries(validated)) {
      if (value === undefined) continue;
      const prismaKey = fieldMap[key];
      if (!prismaKey) continue;
      (updates as Record<string, unknown>)[prismaKey] = value;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "No valid fields to update" },
        { status: 400 }
      );
    }

    // The Settings table is a singleton — there should be exactly one row when
    // setupCompleted=true. We look it up explicitly so we can target a single
    // row (Prisma updateMany doesn't return the updated record).
    const existing = await prisma.settings.findFirst({
      where: { setupCompleted: true },
      select: { id: true },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Settings not found" },
        { status: 404 }
      );
    }

    const settings = await prisma.settings.update({
      where: { id: existing.id },
      data: updates,
      select: SETTINGS_SELECT,
    });

    // Audit log
    audit({
      actorId: authResult.id,
      actorEmail: authResult.email,
      actorType: "admin",
      action: "settings.update",
      targetType: "settings",
      details: { fields: Object.keys(updates) },
    });

    // Clear the cached config so changes take effect immediately
    clearConfigCache();

    // Revalidate all pages so theme changes apply everywhere
    revalidatePath("/", "layout");

    return NextResponse.json({ settings: serializeSettings(settings) });
  } catch (error) {
    console.error("Settings update error:", error);
    return NextResponse.json(
      { error: "Failed to update settings" },
      { status: 500 }
    );
  }
}
