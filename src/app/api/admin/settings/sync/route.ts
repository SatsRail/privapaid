import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { clearConfigCache } from "@/config/instance";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function syncProductCaches(secretKey: string): Promise<number> {
  let synced = 0;
  try {
    const productsResponse = await satsrail.listProducts(secretKey);
    const products = productsResponse.data || [];

    const productMap = new Map<
      string,
      {
        productName: string;
        productPriceCents: number | undefined;
        productCurrency: string | undefined;
        productAccessDurationSeconds: number | undefined;
        productStatus: string | undefined;
        productSlug: string | undefined;
        productExternalRef: string | null;
        syncedAt: Date;
      }
    >();
    for (const p of products) {
      productMap.set(p.id, {
        productName: p.name,
        productPriceCents: p.price_cents,
        productCurrency: p.currency,
        productAccessDurationSeconds: p.access_duration_seconds,
        productStatus: p.status,
        productSlug: p.slug,
        productExternalRef: p.external_ref ?? null,
        syncedAt: new Date(),
      });
    }

    const mediaProducts = await prisma.mediaProduct.findMany({
      select: { id: true, satsrailProductId: true },
    });
    for (const mp of mediaProducts) {
      const cached = productMap.get(mp.satsrailProductId);
      if (cached) {
        await prisma.mediaProduct.update({ where: { id: mp.id }, data: cached });
        synced++;
      }
    }

    const channelProducts = await prisma.channelProduct.findMany({
      select: { id: true, satsrailProductId: true },
    });
    for (const cp of channelProducts) {
      const cached = productMap.get(cp.satsrailProductId);
      if (cached) {
        await prisma.channelProduct.update({ where: { id: cp.id }, data: cached });
        synced++;
      }
    }
  } catch (productError) {
    console.error("Product sync error (non-fatal):", productError);
  }
  return synced;
}

export async function POST() {
  const authResult = await requireOwnerApi();
  if (authResult instanceof NextResponse) return authResult;

  try {
    const secretKey = await getMerchantKey();
    if (!secretKey) {
      return NextResponse.json(
        { error: "No SatsRail API key configured" },
        { status: 400 }
      );
    }

    const merchant = await satsrail.getMerchant(secretKey);

    const settings = await prisma.settings.findFirst({
      where: { setupCompleted: true },
      select: { id: true, logoBytes: true },
    });

    if (!settings) {
      return NextResponse.json(
        { error: "Settings not found" },
        { status: 404 }
      );
    }

    const updates: {
      merchantName: string;
      merchantCurrency: string;
      merchantLocale: string;
      logoUrl?: string;
    } = {
      merchantName: merchant.name || "",
      merchantCurrency: merchant.currency || "USD",
      merchantLocale: merchant.locale || "en",
    };

    // Only update logoUrl if no custom logo was uploaded via Bytes column.
    const hasCustomLogo = Boolean(settings.logoBytes);
    if (!hasCustomLogo) {
      updates.logoUrl = merchant.logo_url || "";
    }

    await prisma.settings.update({
      where: { id: settings.id },
      data: updates,
    });

    const productsSynced = await syncProductCaches(secretKey);

    audit({
      actorId: authResult.id,
      actorEmail: authResult.email,
      actorType: "admin",
      action: "settings.sync_merchant",
      targetType: "settings",
      details: { fields: Object.keys(updates), products_synced: productsSynced },
    });

    clearConfigCache();
    revalidatePath("/", "layout");

    return NextResponse.json({
      logo_url: hasCustomLogo ? undefined : (merchant.logo_url || ""),
      merchant_name: merchant.name || "",
      products_synced: productsSynced,
      synced: true,
    });
  } catch (error) {
    console.error("Merchant sync error:", error);
    const message =
      error instanceof Error && error.message.includes("401")
        ? "Invalid API key. Check your SatsRail credentials."
        : "Failed to sync merchant data.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
