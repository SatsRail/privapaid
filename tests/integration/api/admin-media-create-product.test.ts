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

const { mockEncryptSourceUrl } = vi.hoisted(() => ({
  mockEncryptSourceUrl: vi.fn().mockReturnValue("encrypted_blob_456"),
}));
vi.mock("@/lib/content-encryption", () => ({
  encryptSourceUrl: mockEncryptSourceUrl,
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/media/[id]/create-product/route";
import { createChannel, createMedia } from "../../helpers/factories";

function buildRequest(
  mediaId: string,
  body: unknown
): [NextRequest, { params: Promise<{ id: string }> }] {
  const url = new URL(`http://localhost:3000/api/admin/media/${mediaId}/create-product`);
  return [
    new NextRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: mediaId }) },
  ];
}

describe("Admin Media Create Product", () => {
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

  it("creates a media product and encrypts source URL", async () => {
    const channel = await createChannel({
      slug: "ch-media-prod",
      satsrail_product_type_id: "pt_123",
    });
    const media = await createMedia(channel._id.toString(), {
      source_url: "https://example.com/video.mp4",
    });

    mockSatsrailClient.createProduct.mockResolvedValue({
      id: "prod_m1",
      name: "Media Access",
      price_cents: 500,
      slug: "media-access",
    });
    mockSatsrailClient.getProductKey.mockResolvedValue({
      key: "base64key",
      key_fingerprint: "fp_xyz",
    });

    const [req, ctx] = buildRequest(media._id.toString(), {
      name: "Media Access",
      price_cents: 500,
      currency: "USD",
    });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.media_product).toBeDefined();
    expect(body.data.product.id).toBe("prod_m1");
    expect(body.data.product.name).toBe("Media Access");
    expect(body.data.product.slug).toBe("media-access");
  });

  it("returns 422 when name is missing", async () => {
    const channel = await createChannel({ slug: "ch-no-name" });
    const media = await createMedia(channel._id.toString());
    const [req, ctx] = buildRequest(media._id.toString(), { price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe("name and price_cents are required");
  });

  it("returns 422 when price_cents is missing", async () => {
    const channel = await createChannel({ slug: "ch-no-price" });
    const media = await createMedia(channel._id.toString());
    const [req, ctx] = buildRequest(media._id.toString(), { name: "Test" });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe("name and price_cents are required");
  });

  it("returns 404 when media not found", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const [req, ctx] = buildRequest(fakeId, { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Media not found");
  });

  it("returns 422 when parent channel not found", async () => {
    // Create media with a channel_id that doesn't exist
    const fakeChannelId = new mongoose.Types.ObjectId().toString();
    const media = await createMedia(fakeChannelId);

    const [req, ctx] = buildRequest(media._id.toString(), { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe("Channel not found");
  });

  it("returns 422 when channel has no product type", async () => {
    const channel = await createChannel({ slug: "ch-no-pt", satsrail_product_type_id: null });
    const media = await createMedia(channel._id.toString());

    const [req, ctx] = buildRequest(media._id.toString(), { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toContain("no SatsRail product type");
  });

  it("returns 422 when merchant key not configured", async () => {
    mockGetMerchantKey.mockResolvedValue(null);
    const channel = await createChannel({ slug: "ch-no-key", satsrail_product_type_id: "pt_1" });
    const media = await createMedia(channel._id.toString());

    const [req, ctx] = buildRequest(media._id.toString(), { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe("Merchant API key not configured");
  });

  it("returns 500 when satsrail API throws Error", async () => {
    const channel = await createChannel({ slug: "ch-api-err", satsrail_product_type_id: "pt_1" });
    const media = await createMedia(channel._id.toString());
    mockSatsrailClient.createProduct.mockRejectedValue(new Error("Upstream error"));

    const [req, ctx] = buildRequest(media._id.toString(), { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Upstream error");
  });

  it("returns 500 with generic message for non-Error throws", async () => {
    const channel = await createChannel({ slug: "ch-non-err", satsrail_product_type_id: "pt_1" });
    const media = await createMedia(channel._id.toString());
    mockSatsrailClient.createProduct.mockRejectedValue("raw string");

    const [req, ctx] = buildRequest(media._id.toString(), { name: "Test", price_cents: 500 });
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to create product");
  });

  // -------------------------------------------------------
  // Photo media — envelope encryption (DEK wrapping)
  // -------------------------------------------------------
  describe("photo media (envelope encryption)", () => {
    it("requires the DEK in the body for photo media — 422 otherwise", async () => {
      const channel = await createChannel({
        slug: "ch-photo-nodek",
        satsrail_product_type_id: "pt_photo",
      });
      const media = await createMedia(channel._id.toString(), {
        media_type: "photo",
        source_url: "gridfs:abc123",
      });

      const [req, ctx] = buildRequest(media._id.toString(), {
        name: "Photo Access",
        price_cents: 500,
      });
      const res = await POST(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(422);
      expect(body.error).toContain("dek");
      // SatsRail must not be touched if the request is invalid
      expect(mockSatsrailClient.createProduct).not.toHaveBeenCalled();
    });

    it("wraps the DEK (not source_url) under the product key for photo media", async () => {
      const channel = await createChannel({
        slug: "ch-photo-dek",
        satsrail_product_type_id: "pt_photo",
      });
      const media = await createMedia(channel._id.toString(), {
        media_type: "photo",
        source_url: "gridfs:photo-bytes-id-xyz",
      });

      mockSatsrailClient.createProduct.mockResolvedValue({
        id: "prod_photo",
        name: "Photo Access",
        price_cents: 500,
        slug: "photo-access",
      });
      mockSatsrailClient.getProductKey.mockResolvedValue({
        key: "base64-product-key",
        key_fingerprint: "fp_photo",
      });

      const dekBase64url = "DEKbase64url-fake-32-bytes-encoded-xyz";
      const [req, ctx] = buildRequest(media._id.toString(), {
        name: "Photo Access",
        price_cents: 500,
        currency: "USD",
        dek: dekBase64url,
      });
      const res = await POST(req, ctx);
      expect(res.status).toBe(201);

      // The crucial assertion: the plaintext passed to encryptSourceUrl must be
      // the DEK, not the source_url. Otherwise envelope encryption is broken.
      expect(mockEncryptSourceUrl).toHaveBeenCalledTimes(1);
      const [plaintext, key, productId] = mockEncryptSourceUrl.mock.calls[0];
      expect(plaintext).toBe(dekBase64url);
      expect(plaintext).not.toBe(media.source_url);
      expect(key).toBe("base64-product-key");
      expect(productId).toBe("prod_photo");
    });

    it("non-photo media continues to wrap source_url unchanged", async () => {
      const channel = await createChannel({
        slug: "ch-video-baseline",
        satsrail_product_type_id: "pt_video",
      });
      const media = await createMedia(channel._id.toString(), {
        media_type: "video",
        source_url: "https://example.com/video.mp4",
      });

      mockSatsrailClient.createProduct.mockResolvedValue({
        id: "prod_video",
        name: "Video",
        price_cents: 500,
        slug: "video",
      });
      mockSatsrailClient.getProductKey.mockResolvedValue({
        key: "video-key",
        key_fingerprint: "fp_video",
      });

      const [req, ctx] = buildRequest(media._id.toString(), {
        name: "Video",
        price_cents: 500,
        // dek ignored when media is not a photo
        dek: "ignored-dek",
      });
      const res = await POST(req, ctx);
      expect(res.status).toBe(201);

      // For non-photo, encryptSourceUrl receives the URL, not the DEK.
      const [plaintext] = mockEncryptSourceUrl.mock.calls[0];
      expect(plaintext).toBe("https://example.com/video.mp4");
    });
  });
});
