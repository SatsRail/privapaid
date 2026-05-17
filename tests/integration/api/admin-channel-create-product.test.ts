import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";

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
vi.mock("@/lib/mongodb", () => ({ connectDB: vi.fn().mockImplementation(async () => mongoose) }));
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
vi.mock("@/lib/content-encryption", () => ({
  encryptSourceUrl: mockEncryptSourceUrl,
  decryptSourceUrl: mockDecryptSourceUrl,
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/channels/[id]/create-product/route";
import { createChannel, createMedia } from "../../helpers/factories";
import MediaProduct from "@/models/MediaProduct";

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

  it("creates a channel product and encrypts media", async () => {
    const channel = await createChannel({
      name: "Test Channel",
      slug: "test-ch",
      satsrail_product_type_id: "pt_123",
    });
    await createMedia(channel._id.toString(), { source_url: "https://example.com/v1.mp4" });
    await createMedia(channel._id.toString(), { source_url: "https://example.com/v2.mp4" });

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

    const [req, ctx] = buildRequest(channel._id.toString(), {
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
    const [req, ctx] = buildRequest(channel._id.toString(), { price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe("name and price_cents are required");
  });

  it("returns 422 when price_cents is missing", async () => {
    const channel = await createChannel({ slug: "no-price" });
    const [req, ctx] = buildRequest(channel._id.toString(), { name: "Test" });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe("name and price_cents are required");
  });

  it("returns 404 when channel not found", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const [req, ctx] = buildRequest(fakeId, { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Channel not found");
  });

  it("returns 422 when channel has no product type", async () => {
    const channel = await createChannel({ slug: "no-pt", satsrail_product_type_id: null });
    const [req, ctx] = buildRequest(channel._id.toString(), { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toContain("no SatsRail product type");
  });

  it("returns 422 when channel has no ref", async () => {
    const channel = await createChannel({ slug: "no-ref", ref: null, satsrail_product_type_id: "pt_1" });
    const [req, ctx] = buildRequest(channel._id.toString(), { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe("Channel has no ref assigned");
  });

  it("returns 422 when merchant key not configured", async () => {
    mockGetMerchantKey.mockResolvedValue(null);
    const channel = await createChannel({ slug: "no-key", satsrail_product_type_id: "pt_1" });
    const [req, ctx] = buildRequest(channel._id.toString(), { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe("Merchant API key not configured");
  });

  it("returns 500 when satsrail API throws", async () => {
    const channel = await createChannel({ slug: "api-err", satsrail_product_type_id: "pt_1" });
    mockSatsrailClient.createProduct.mockRejectedValue(new Error("API down"));

    const [req, ctx] = buildRequest(channel._id.toString(), { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("API down");
  });

  it("returns 500 with generic message for non-Error throws", async () => {
    const channel = await createChannel({ slug: "non-err", satsrail_product_type_id: "pt_1" });
    mockSatsrailClient.createProduct.mockRejectedValue("string error");

    const [req, ctx] = buildRequest(channel._id.toString(), { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to create channel product");
  });

  // -------------------------------------------------------
  // Photo media — envelope encryption: DEK recovery + re-wrap
  // -------------------------------------------------------
  describe("photo media in channel product (envelope re-wrap)", () => {
    it("returns 422 when a photo has no existing MediaProduct to recover the DEK from", async () => {
      const channel = await createChannel({
        slug: "ch-photo-no-mp",
        satsrail_product_type_id: "pt_1",
        ref: 999,
      });
      await createMedia(channel._id.toString(), {
        media_type: "photo",
        source_url: "gridfs:photo-orphan",
      });

      mockSatsrailClient.createProduct.mockResolvedValue({
        id: "prod_channel",
        name: "Channel",
        price_cents: 1000,
        slug: "channel",
        access_duration_seconds: null,
        status: "active",
      });
      mockSatsrailClient.getProductKey.mockResolvedValue({
        key: "channel-product-key",
        key_fingerprint: "fp_ch",
      });

      const [req, ctx] = buildRequest(channel._id.toString(), {
        name: "Channel",
        price_cents: 1000,
      });
      const res = await POST(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(422);
      expect(body.error).toContain("no existing product to recover DEK from");
      // No decrypt or rewrap should have been attempted
      expect(mockDecryptSourceUrl).not.toHaveBeenCalled();
    });

    it("recovers the DEK from an existing MediaProduct and re-wraps under the new product key", async () => {
      const channel = await createChannel({
        slug: "ch-photo-rewrap",
        satsrail_product_type_id: "pt_1",
        ref: 1001,
      });
      const photoMedia = await createMedia(channel._id.toString(), {
        media_type: "photo",
        source_url: "gridfs:photo-bytes-id",
      });

      // Seed an existing MediaProduct so the server has a DEK envelope to unwrap.
      await MediaProduct.create({
        media_id: photoMedia._id,
        satsrail_product_id: "prod_existing",
        encrypted_source_url: "encrypted-dek-for-prod_existing",
        key_fingerprint: "fp_existing",
      });

      mockSatsrailClient.createProduct.mockResolvedValue({
        id: "prod_new_channel",
        name: "Channel",
        price_cents: 1000,
        slug: "channel",
        access_duration_seconds: null,
        status: "active",
      });
      mockSatsrailClient.getProductKey
        // First call: fetch the new channel product's key
        .mockResolvedValueOnce({ key: "new-channel-key", key_fingerprint: "fp_new" })
        // Second call: fetch the OTHER product's key (so we can decrypt its DEK)
        .mockResolvedValueOnce({ key: "existing-product-key", key_fingerprint: "fp_existing" });

      mockDecryptSourceUrl.mockReturnValueOnce("photo-dek-base64url");
      mockEncryptSourceUrl.mockReturnValueOnce("re-wrapped-dek-blob");

      const [req, ctx] = buildRequest(channel._id.toString(), {
        name: "Channel",
        price_cents: 1000,
      });
      const res = await POST(req, ctx);
      expect(res.status).toBe(201);

      // The recovered DEK must be re-encrypted with the NEW channel key, not
      // the existing product key. Otherwise viewers of the new channel product
      // can't decrypt.
      expect(mockDecryptSourceUrl).toHaveBeenCalledWith(
        "encrypted-dek-for-prod_existing",
        "existing-product-key",
        "prod_existing"
      );
      expect(mockEncryptSourceUrl).toHaveBeenCalledWith(
        "photo-dek-base64url",
        "new-channel-key",
        "prod_new_channel"
      );
    });

    it("mixes photo and non-photo media in the same channel correctly", async () => {
      const channel = await createChannel({
        slug: "ch-mixed",
        satsrail_product_type_id: "pt_1",
        ref: 1002,
      });
      const videoMedia = await createMedia(channel._id.toString(), {
        media_type: "video",
        source_url: "https://example.com/v.mp4",
      });
      const photoMedia = await createMedia(channel._id.toString(), {
        media_type: "photo",
        source_url: "gridfs:photo-id",
      });
      await MediaProduct.create({
        media_id: photoMedia._id,
        satsrail_product_id: "prod_existing_mixed",
        encrypted_source_url: "existing-dek-blob",
        key_fingerprint: "fp_e",
      });

      mockSatsrailClient.createProduct.mockResolvedValue({
        id: "prod_mixed_channel",
        name: "Mixed",
        price_cents: 1000,
        slug: "mixed",
        access_duration_seconds: null,
        status: "active",
      });
      mockSatsrailClient.getProductKey
        .mockResolvedValueOnce({ key: "mixed-channel-key", key_fingerprint: "fp_m" })
        .mockResolvedValueOnce({ key: "existing-product-key", key_fingerprint: "fp_e" });
      mockDecryptSourceUrl.mockReturnValue("recovered-dek");

      const [req, ctx] = buildRequest(channel._id.toString(), {
        name: "Mixed",
        price_cents: 1000,
      });
      const res = await POST(req, ctx);
      expect(res.status).toBe(201);

      // Video gets URL-encrypted; photo gets DEK-encrypted. Both go under
      // the same channel key + product ID.
      const calls = mockEncryptSourceUrl.mock.calls;
      const plaintexts = calls.map((c) => c[0]);
      expect(plaintexts).toContain(videoMedia.source_url); // URL
      expect(plaintexts).toContain("recovered-dek"); // DEK
      // All encrypt calls share the channel key + new product id
      for (const [, key, productId] of calls) {
        expect(key).toBe("mixed-channel-key");
        expect(productId).toBe("prod_mixed_channel");
      }
    });
  });
});
