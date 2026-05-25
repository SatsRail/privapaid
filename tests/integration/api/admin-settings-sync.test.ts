import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { NextResponse } from "next/server";

// ── Hoisted mocks ──────────────────────────────────────────────────
const { mockRequireOwnerApi, mockGetMerchantKey, mockSatsrail } = vi.hoisted(() => ({
  mockRequireOwnerApi: vi.fn().mockResolvedValue({
    id: "admin-1",
    email: "admin@test.com",
    role: "owner",
  }),
  mockGetMerchantKey: vi.fn().mockResolvedValue("sk_test_key"),
  mockSatsrail: {
    getMerchant: vi.fn().mockResolvedValue({
      name: "Test Merchant",
      currency: "USD",
      locale: "en",
      logo_url: "https://example.com/logo.png",
    }),
    listProducts: vi.fn().mockResolvedValue({ data: [] }),
  },
}));

vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  requireOwnerApi: mockRequireOwnerApi,
}));
vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: mockGetMerchantKey,
}));
vi.mock("@/lib/satsrail", () => ({
  satsrail: mockSatsrail,
}));
vi.mock("@/config/instance", () => ({
  clearConfigCache: vi.fn(),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { POST } from "@/app/api/admin/settings/sync/route";
import { prisma } from "@/lib/prisma";
import { createSettings, createChannel, createMedia } from "../../helpers/factories";

describe("Admin Settings Sync — POST /api/admin/settings/sync", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
  });

  it("returns auth error when requireOwnerApi fails", async () => {
    mockRequireOwnerApi.mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );

    const res = await POST();
    expect(res.status).toBe(401);
  });

  it("returns 400 when no merchant key configured", async () => {
    mockGetMerchantKey.mockResolvedValueOnce(null);

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("No SatsRail API key configured");
  });

  it("returns 404 when settings not found", async () => {
    // No settings in DB
    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Settings not found");
  });

  it("syncs merchant data and returns results", async () => {
    await createSettings({ instanceName: "Test Instance" });

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.synced).toBe(true);
    expect(body.merchant_name).toBe("Test Merchant");
    expect(body.logo_url).toBe("https://example.com/logo.png");
    expect(body.products_synced).toBe(0);
  });

  it("skips logo_url when custom logoBytes exists", async () => {
    await createSettings({ instanceName: "Test Instance" });
    await prisma.settings.update({
      where: { id: 1 },
      data: { logoBytes: Buffer.from("fake-bytes"), logoMimeType: "image/png" },
    });

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.logo_url).toBeUndefined();
  });

  it("syncs product data to MediaProduct and ChannelProduct caches", async () => {
    await createSettings({ instanceName: "Test Instance" });
    const channel = await createChannel();
    const media = await createMedia(channel.id);

    const mp = await prisma.mediaProduct.create({
      data: {
        mediaId: media.id,
        satsrailProductId: "prod_1",
        encryptedSourceUrl: "enc_url",
      },
    });

    const cp = await prisma.channelProduct.create({
      data: {
        channelId: channel.id,
        satsrailProductId: "prod_2",
      },
    });

    mockSatsrail.listProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_1",
          name: "Product One",
          price_cents: 1000,
          currency: "USD",
          access_duration_seconds: 3600,
          status: "active",
          slug: "product-one",
        },
        {
          id: "prod_2",
          name: "Product Two",
          price_cents: 2000,
          currency: "EUR",
          access_duration_seconds: 7200,
          status: "active",
          slug: "product-two",
        },
      ],
    });

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.products_synced).toBe(2);

    // Verify MediaProduct was updated
    const updatedMp = await prisma.mediaProduct.findUnique({ where: { id: mp.id } });
    expect(updatedMp!.productName).toBe("Product One");
    expect(updatedMp!.productPriceCents).toBe(1000);

    // Verify ChannelProduct was updated
    const updatedCp = await prisma.channelProduct.findUnique({ where: { id: cp.id } });
    expect(updatedCp!.productName).toBe("Product Two");
    expect(updatedCp!.productCurrency).toBe("EUR");
  });

  it("handles product sync error gracefully (non-fatal)", async () => {
    await createSettings({ instanceName: "Test Instance" });

    mockSatsrail.listProducts.mockRejectedValueOnce(new Error("API error"));

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.synced).toBe(true);
    expect(body.products_synced).toBe(0);
  });

  it("returns 500 with invalid key message for 401 errors", async () => {
    mockSatsrail.getMerchant.mockRejectedValueOnce(new Error("Request failed: 401"));

    await createSettings({ instanceName: "Test Instance" });

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain("Invalid API key");
  });

  it("returns 500 with generic message for other errors", async () => {
    mockSatsrail.getMerchant.mockRejectedValueOnce(new Error("Connection timeout"));

    await createSettings({ instanceName: "Test Instance" });

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to sync merchant data.");
  });

  it("handles empty merchant name and currency", async () => {
    await createSettings({ instanceName: "Test Instance" });

    mockSatsrail.getMerchant.mockResolvedValueOnce({
      name: null,
      currency: null,
      locale: null,
      logo_url: null,
    });

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.merchant_name).toBe("");
    expect(body.logo_url).toBe("");
  });

  it("does not update products that are not in the SatsRail response", async () => {
    await createSettings({ instanceName: "Test Instance" });
    const channel = await createChannel();
    const media = await createMedia(channel.id);

    await prisma.mediaProduct.create({
      data: {
        mediaId: media.id,
        satsrailProductId: "prod_orphan",
        encryptedSourceUrl: "enc",
        productName: "Old Name",
      },
    });

    mockSatsrail.listProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_other",
          name: "Other Product",
          price_cents: 500,
          currency: "USD",
          access_duration_seconds: 1800,
          status: "active",
          slug: "other-product",
        },
      ],
    });

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.products_synced).toBe(0);
  });
});
