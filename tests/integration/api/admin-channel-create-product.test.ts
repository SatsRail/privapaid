import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct } from "../../helpers/factories";

const { mockGetMerchantKey, mockSatsrailClient } = vi.hoisted(() => ({
  mockGetMerchantKey: vi.fn().mockResolvedValue("sk_test_key"),
  mockSatsrailClient: {
    createProduct: vi.fn(),
    getProductKey: vi.fn(),
  },
}));

// Mocks — MUST be before route imports
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
  requireOwnerApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
  requireCustomerApi: vi.fn().mockResolvedValue({ id: "customer-1", name: "testuser" }),
}));
vi.mock("@/lib/satsrail", () => ({ satsrail: mockSatsrailClient }));
vi.mock("@/lib/merchant-key", () => ({ getMerchantKey: mockGetMerchantKey }));

const { mockEncryptSourceUrl, mockDecryptSourceUrl } = vi.hoisted(() => ({
  mockEncryptSourceUrl: vi.fn().mockReturnValue("encrypted_blob_123"),
  mockDecryptSourceUrl: vi.fn().mockReturnValue("dek-recovered-base64url"),
}));
// Keep the real encryptBytes/decryptBytes so the createMedia factory (which
// mints a real MediaEnvelope) still works; only spy on the URL/DEK wrappers.
vi.mock("@/lib/content-encryption", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/content-encryption")>()),
  encryptSourceUrl: mockEncryptSourceUrl,
  decryptSourceUrl: mockDecryptSourceUrl,
}));

const { mockUnwrapDekToBase64url } = vi.hoisted(() => ({
  mockUnwrapDekToBase64url: vi.fn(),
}));
// Keep the real wrapDek (factory needs it); only spy on unwrapDekToBase64url.
vi.mock("@/lib/content-dek", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/content-dek")>()),
  unwrapDekToBase64url: mockUnwrapDekToBase64url,
}));

import { NextRequest, NextResponse } from "next/server";
import { POST } from "@/app/api/admin/channels/[id]/create-product/route";
import { createChannel, createMedia } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";

function buildRequest(
  channelId: string,
  body: unknown
): [NextRequest, { params: Promise<{ id: string }> }] {
  const url = `http://localhost:3000/api/admin/channels/${channelId}/create-product`;
  return [
    new NextRequest(new URL(url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: channelId }) },
  ];
}

describe("Admin Channel Create Product", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    mockGetMerchantKey.mockResolvedValue("sk_test_key");
  });

  it("returns 401 when the caller is not an admin", async () => {
    vi.mocked(requireAdminApi).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const [req, ctx] = buildRequest("any-channel-id", {
      name: "Channel Access",
      price_cents: 1000,
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
  });

  it("creates a channel product and encrypts media", async () => {
    const channel = await createChannel({
      name: "Test Channel",
      slug: "test-ch",
      satsrailProductTypeId: "pt_123",
    });
    await createMedia(channel.id, { sourceUrl: "https://example.com/v1.mp4" });
    await createMedia(channel.id, { sourceUrl: "https://example.com/v2.mp4" });

    mockSatsrailClient.createProduct.mockResolvedValue({
      id: "prod_1",
      name: "Channel Access",
      price_cents: 1000,
      slug: "channel-access",
    });
    mockSatsrailClient.getProductKey.mockResolvedValue({
      key: "base64key",
      key_fingerprint: "fp_abc",
    });

    const [req, ctx] = buildRequest(channel.id, {
      name: "Channel Access",
      price_cents: 1000,
      currency: "USD",
    });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.channel_product.satsrail_product_id).toBe("prod_1");
    expect(body.data.channel_product.encrypted_media_count).toBe(2);
    expect(body.data.product.name).toBe("Channel Access");
    expect(body.data.product.slug).toBe("channel-access");
  });

  it("returns 422 when name is missing", async () => {
    const channel = await createChannel({ slug: "no-name" });
    const [req, ctx] = buildRequest(channel.id, { price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe("name and price_cents are required");
  });

  it("returns 422 when price_cents is missing", async () => {
    const channel = await createChannel({ slug: "no-price" });
    const [req, ctx] = buildRequest(channel.id, { name: "Test" });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe("name and price_cents are required");
  });

  it("returns 404 when channel not found", async () => {
    const fakeId = "ckmissingfakefakefakefake";
    const [req, ctx] = buildRequest(fakeId, { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Channel not found");
  });

  it("returns 422 when channel has no product type", async () => {
    const channel = await createChannel({ slug: "no-pt", satsrailProductTypeId: null });
    const [req, ctx] = buildRequest(channel.id, { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toContain("no SatsRail product type");
  });

  it("returns 422 when merchant key not configured", async () => {
    mockGetMerchantKey.mockResolvedValue(null);
    const channel = await createChannel({ slug: "no-key", satsrailProductTypeId: "pt_1" });
    const [req, ctx] = buildRequest(channel.id, { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe("Merchant API key not configured");
  });

  it("returns 500 when satsrail API throws", async () => {
    const channel = await createChannel({ slug: "api-err", satsrailProductTypeId: "pt_1" });
    mockSatsrailClient.createProduct.mockRejectedValue(new Error("API down"));

    const [req, ctx] = buildRequest(channel.id, { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("API down");
  });

  it("returns 500 with generic message for non-Error throws", async () => {
    const channel = await createChannel({ slug: "non-err", satsrailProductTypeId: "pt_1" });
    mockSatsrailClient.createProduct.mockRejectedValue("string error");

    const [req, ctx] = buildRequest(channel.id, { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to create channel product");
  });

  // -------------------------------------------------------
  // Photo media — envelope encryption: DEK recovery + re-wrap
  // -------------------------------------------------------
  describe("photo media in channel product (envelope re-wrap)", () => {
    it("recovers the DEK from the media's envelope wrappedDek (no SatsRail decrypt call)", async () => {
      const channel = await createChannel({
        slug: "ch-photo-kek",
        satsrailProductTypeId: "pt_1",
        ref: 2001,
      });
      // The DEK is recovered from MediaEnvelope.wrappedDek (CONTENT_KEK-local).
      // Even though a stale MediaProduct exists, the route must NOT fetch its
      // key from SatsRail to decrypt the DEK — no decryptSourceUrl round-trip.
      const photoMedia = await createMedia(channel.id, {
        mediaType: "photo",
        sourceUrl: "gridfs:photo-with-kek",
      });
      // The real wrappedDek minted by the factory is what the route must unwrap.
      const envelope = await prisma.mediaEnvelope.findUnique({
        where: { mediaId: photoMedia.id },
        select: { wrappedDek: true },
      });
      await createMediaProduct({
          mediaId: photoMedia.id,
          satsrailProductId: "prod_stale",
          encryptedSource: "stale-blob",
          keyFingerprint: "fp_stale",
        });

      mockSatsrailClient.createProduct.mockResolvedValue({
        id: "prod_new_kek_channel",
        name: "Channel",
        price_cents: 1000,
        slug: "channel",
        access_duration_seconds: null,
        status: "active",
      });
      // Only ONE getProductKey call expected — the new channel product's key.
      // The legacy "fetch other product's key to decrypt DEK" call must NOT fire.
      mockSatsrailClient.getProductKey.mockResolvedValueOnce({
        key: "new-channel-key",
        key_fingerprint: "fp_new",
      });
      mockUnwrapDekToBase64url.mockReturnValueOnce("dek-from-kek");
      mockEncryptSourceUrl.mockReturnValueOnce("re-wrapped-via-kek");

      const [req, ctx] = buildRequest(channel.id, {
        name: "Channel",
        price_cents: 1000,
      });
      const res = await POST(req, ctx);
      expect(res.status).toBe(201);

      expect(mockUnwrapDekToBase64url).toHaveBeenCalledWith(envelope!.wrappedDek);
      expect(mockDecryptSourceUrl).not.toHaveBeenCalled();
      expect(mockSatsrailClient.getProductKey).toHaveBeenCalledTimes(1);
      expect(mockEncryptSourceUrl).toHaveBeenCalledWith(
        "dek-from-kek",
        "new-channel-key",
        "prod_new_kek_channel"
      );
    });

    it("wraps every media's envelope DEK under the channel key (uniform two-step)", async () => {
      const channel = await createChannel({
        slug: "ch-mixed",
        satsrailProductTypeId: "pt_1",
        ref: 1002,
      });
      // Both media now follow the same path: the DEK is recovered from each
      // MediaEnvelope.wrappedDek (via the mocked unwrapDekToBase64url) and wrapped
      // under the channel product key. The old "video=URL, photo=DEK" split is gone.
      await createMedia(channel.id, {
        mediaType: "video",
        sourceUrl: "https://example.com/v.mp4",
      });
      await createMedia(channel.id, {
        mediaType: "photo",
        sourceUrl: "gridfs:photo-bytes",
      });

      mockSatsrailClient.createProduct.mockResolvedValue({
        id: "prod_mixed_channel",
        name: "Mixed",
        price_cents: 1000,
        slug: "mixed",
        access_duration_seconds: null,
        status: "active",
      });
      mockSatsrailClient.getProductKey.mockResolvedValueOnce({
        key: "mixed-channel-key",
        key_fingerprint: "fp_m",
      });
      // One recovered DEK per media (route iterates all media in the channel).
      mockUnwrapDekToBase64url
        .mockReturnValueOnce("dek-recovered-1")
        .mockReturnValueOnce("dek-recovered-2");

      const [req, ctx] = buildRequest(channel.id, {
        name: "Mixed",
        price_cents: 1000,
      });
      const res = await POST(req, ctx);
      expect(res.status).toBe(201);

      // Every media's recovered DEK is wrapped under the same channel key + product ID.
      const calls = mockEncryptSourceUrl.mock.calls;
      const plaintexts = calls.map((c) => c[0]);
      expect(plaintexts).toContain("dek-recovered-1");
      expect(plaintexts).toContain("dek-recovered-2");
      for (const [, key, productId] of calls) {
        expect(key).toBe("mixed-channel-key");
        expect(productId).toBe("prod_mixed_channel");
      }
      // No SatsRail decrypt round-trip for DEK recovery — it's CONTENT_KEK-local.
      expect(mockDecryptSourceUrl).not.toHaveBeenCalled();
    });
  });
});
