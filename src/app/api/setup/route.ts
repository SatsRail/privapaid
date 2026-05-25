import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptSecretKey } from "@/lib/encryption";
import { isSetupComplete } from "@/lib/setup";
import { validateBody, isValidationError, schemas } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const complete = await isSetupComplete();
    if (complete) {
      return NextResponse.json(
        { error: "Setup already completed" },
        { status: 403 }
      );
    }

    const result = await validateBody(request, schemas.setup);
    if (isValidationError(result)) return result;

    const {
      instance_name,
      logo_url,
      nsfw_enabled,
      theme_primary,
      satsrail_api_key,
      merchant_id,
      merchant_name,
      merchant_currency,
      merchant_locale,
    } = result;

    // No default categories — merchants start from zero

    const settingsData = {
      setupCompleted: true,
      setupCompletedAt: new Date(),
      instanceName: instance_name.trim(),
      logoUrl: logo_url?.trim() || "",
      nsfwEnabled: nsfw_enabled === true,
      themePrimary: theme_primary || "#3b82f6",
      satsrailApiUrl:
        process.env.SATSRAIL_API_URL || "https://satsrail.com/api/v1",
      satsrailApiKeyEncrypted: encryptSecretKey(satsrail_api_key.trim()),
      merchantId: merchant_id.trim(),
      merchantName: merchant_name?.trim() || "",
      merchantCurrency: merchant_currency || "USD",
      merchantLocale: merchant_locale || "en",
    };

    // Settings is a singleton (id = 1). Use upsert so re-running setup
    // overwrites the existing row instead of failing on the unique id.
    await prisma.settings.upsert({
      where: { id: 1 },
      create: { id: 1, ...settingsData },
      update: settingsData,
    });

    return NextResponse.json(
      { message: "Setup completed successfully" },
      { status: 201 }
    );
  } catch (error) {
    console.error("Setup error:", error);
    return NextResponse.json(
      { error: "Setup failed. Please try again." },
      { status: 500 }
    );
  }
}
