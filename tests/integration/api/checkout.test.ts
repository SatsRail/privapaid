import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct, createChannelProduct } from "../../helpers/factories";

// ── Hoisted mocks ──────────────────────────────────────────────────
const { mockGetMerchantKey, mockSatsrail, mockRateLimit } = vi.hoisted(() => ({
  mockGetMerchantKey: vi.fn().mockResolvedValue("sk_test_key"),
  mockSatsrail: {
    getProduct: vi.fn().mockResolvedValue({
      id: "prod_1",
      name: "Test Product",
      slug: "test-product",
      status: "active",
    }),
    createCheckoutSession: vi.fn().mockResolvedValue({
      checkout_url: "https://satsrail.com/checkout/sess_abc",
      token: "sess_abc",
    }),
  },
  mockRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: mockGetMerchantKey,
}));
vi.mock("@/lib/satsrail", () => ({
  satsrail: mockSatsrail,
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/checkout/route";
import { prisma } from "@/lib/prisma";

let refSeed = 5000;
function nextRef(): number {
  refSeed += 1;
  return refSeed;
}

function buildRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/checkout"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Checkout API — POST /api/checkout", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    // Restore defaults
    mockGetMerchantKey.mockResolvedValue("sk_test_key");
    mockSatsrail.getProduct.mockResolvedValue({
      id: "prod_1",
      name: "Test Product",
      slug: "test-product",
      status: "active",
    });
    mockSatsrail.createCheckoutSession.mockResolvedValue({
      checkout_url: "https://satsrail.com/checkout/sess_abc",
      token: "sess_abc",
    });
  });

  async function seedWithMediaProduct() {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `checkout-ch-${nextRef()}`,
        name: "Checkout Channel",
        active: true,
      },
    });

    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Paid Media",
        blob: { kind: "url", url: "https://example.com/paid.mp4" },
        mediaType: "video",
      },
    });

    await createMediaProduct({
      mediaId: media.id,
      satsrailProductId: "prod_1",
      encryptedSource: "enc_blob",
    });

    return { channelId: channel.id, mediaId: media.id };
  }

  async function seedWithChannelProduct() {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `checkout-ch-cp-${nextRef()}`,
        name: "Channel Product Checkout",
        active: true,
      },
    });

    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Channel Paid Media",
        blob: { kind: "url", url: "https://example.com/chpaid.mp4" },
        mediaType: "video",
      },
    });

    await createChannelProduct({
      channelId: channel.id,
      satsrailProductId: "prod_ch",
      encryptedMedia: [{ mediaId: media.id, encryptedSource: "ch_enc_blob" }],
    });

    return { channelId: channel.id, mediaId: media.id };
  }

  it("returns 400 when media_id is missing", async () => {
    const req = buildRequest({ product_id: "prod_1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when product_id is missing", async () => {
    const req = buildRequest({ media_id: "ckmissingfakefakefakefake" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest(new URL("http://localhost:3000/api/checkout"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 404 when media not found", async () => {
    const fakeId = "ckmissingfakefakefakefake";
    const req = buildRequest({ media_id: fakeId, product_id: "prod_1" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Media not found");
  });

  it("returns 404 when channel is inactive", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `inactive-checkout-${nextRef()}`,
        name: "Inactive",
        active: false,
      },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Inactive Channel Media",
        blob: { kind: "url", url: "https://example.com/inactive.mp4" },
        mediaType: "video",
      },
    });

    const req = buildRequest({ media_id: media.id, product_id: "prod_1" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Channel not found");
  });

  it("returns 400 when product not linked to media", async () => {
    const { mediaId } = await seedWithMediaProduct();

    const req = buildRequest({ media_id: mediaId, product_id: "prod_not_linked" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Product not linked to this media");
  });

  it("returns 422 when merchant key not configured", async () => {
    const { mediaId } = await seedWithMediaProduct();
    mockGetMerchantKey.mockResolvedValueOnce(null);

    const req = buildRequest({ media_id: mediaId, product_id: "prod_1" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe("Merchant API key not configured");
  });

  it("returns 400 when product is not active", async () => {
    const { mediaId } = await seedWithMediaProduct();
    mockSatsrail.getProduct.mockResolvedValueOnce({
      id: "prod_1",
      name: "Archived Product",
      slug: "archived-product",
      status: "archived",
    });

    const req = buildRequest({ media_id: mediaId, product_id: "prod_1" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Product is not available for purchase");
  });

  it("returns 404 when product not found on SatsRail", async () => {
    const { mediaId } = await seedWithMediaProduct();
    mockSatsrail.getProduct.mockRejectedValueOnce(new Error("Not found"));

    const req = buildRequest({ media_id: mediaId, product_id: "prod_1" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Product not found on SatsRail");
  });

  it("creates checkout session and returns url/token for media product", async () => {
    const { mediaId } = await seedWithMediaProduct();

    const req = buildRequest({ media_id: mediaId, product_id: "prod_1" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBe("https://satsrail.com/checkout/sess_abc");
    expect(body.token).toBe("sess_abc");
    expect(mockSatsrail.createCheckoutSession).toHaveBeenCalledWith("sk_test_key", {
      checkout_session: { product_id: "test-product" },
    });
  });

  it("creates checkout session via channel product", async () => {
    const { mediaId } = await seedWithChannelProduct();
    mockSatsrail.getProduct.mockResolvedValueOnce({
      id: "prod_ch",
      name: "Channel Product",
      slug: "channel-product",
      status: "active",
    });

    const req = buildRequest({ media_id: mediaId, product_id: "prod_ch" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBeDefined();
    expect(body.token).toBeDefined();
  });

  it("returns 500 when createCheckoutSession throws", async () => {
    const { mediaId } = await seedWithMediaProduct();
    mockSatsrail.createCheckoutSession.mockRejectedValueOnce(new Error("API error"));

    const req = buildRequest({ media_id: mediaId, product_id: "prod_1" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to create checkout session");
  });

  it("returns rate limit response when rate limited", async () => {
    const { NextResponse } = await import("next/server");
    mockRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Too many requests" }, { status: 429 })
    );

    const req = buildRequest({ media_id: "any", product_id: "any" });
    const res = await POST(req);

    expect(res.status).toBe(429);
  });
});
