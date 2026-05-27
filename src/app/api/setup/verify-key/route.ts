import { NextResponse } from "next/server";
import { satsrail } from "@/lib/satsrail";
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

    const result = await validateBody(request, schemas.verifyKey);
    if (isValidationError(result)) return result;

    const merchant = await satsrail.getMerchant(result.satsrail_api_key);

    return NextResponse.json({
      merchant_id: merchant.id,
      merchant_name: merchant.name,
      merchant_currency: merchant.currency || "USD",
      merchant_locale: merchant.locale || "en",
      merchant_logo_url: merchant.logo_url || "",
    });
  } catch (error) {
    console.error("Verify key error:", error);
    let message = "Failed to verify API key. Check your connection.";
    if (error instanceof Error) {
      if (error.message.includes("401")) {
        message = "Invalid API key";
      } else if (error.message.includes("403")) {
        message =
          "Merchant account is not yet active. Complete setup in the SatsRail portal first.";
      } else if (error.message.includes("404")) {
        message =
          "SatsRail endpoint not found. Check that SATSRAIL_API_URL includes the /api/v1 suffix.";
      }
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
