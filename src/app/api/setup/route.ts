import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { encryptSecretKey } from "@/lib/encryption";
import { isSetupComplete } from "@/lib/setup";
import Settings from "@/models/Settings";
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

    await connectDB();

    // No default categories — merchants start from zero

    // Build settings
    const settingsData: Record<string, unknown> = {
      setup_completed: true,
      setup_completed_at: new Date(),
      instance_name: instance_name.trim(),
      logo_url: logo_url?.trim() || "",
      nsfw_enabled: nsfw_enabled === true,
      theme_primary: theme_primary || "#3b82f6",
      satsrail_api_url:
        process.env.SATSRAIL_API_URL || "https://satsrail.com/api/v1",
      satsrail_api_key_encrypted: encryptSecretKey(satsrail_api_key.trim()),
      merchant_id: merchant_id.trim(),
      merchant_name: merchant_name?.trim() || "",
      merchant_currency: merchant_currency || "USD",
      merchant_locale: merchant_locale || "en",
    };

    await Settings.create(settingsData);

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
