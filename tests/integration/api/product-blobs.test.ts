import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel, createMedia, createMediaProduct, createChannelProduct } from "../../helpers/factories";

// Mock rate limit
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

// Mock admin auth
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: vi.fn().mockResolvedValue({
    id: "admin-1",
    email: "admin@test.com",
    role: "owner",
  }),
}));

import { GET } from "@/app/api/admin/products/[id]/blobs/route";
import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth-helpers";

function buildRequest(
  productId: string
): [Request, { params: Promise<{ id: string }> }] {
  const url = `http://localhost:3000/api/admin/products/${productId}/blobs`;
  return [
    new Request(url, { method: "GET" }),
    { params: Promise.resolve({ id: productId }) },
  ];
}

describe("GET /api/admin/products/[id]/blobs", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("returns empty data when no media products exist for the product", async () => {
    const [req, ctx] = buildRequest("prod-123");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it("returns blob data for media products linked to the product", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id, {
      name: "Encrypted Video",
      mediaType: "video",
      ref: 9999,
    });

    await createMediaProduct({
      mediaId: media.id,
      satsrailProductId: "prod-456",
      encryptedSource: "aes256gcm:abcdefghijklmnopqrstuvwxyz1234567890abcdef",
      keyFingerprint: "sha256:abc123",
    });

    const [req, ctx] = buildRequest("prod-456");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);

    const blob = body.data[0];
    expect(blob.media_id).toBe(media.id);
    expect(blob.media_name).toBe("Encrypted Video");
    expect(blob.media_type).toBe("video");
    expect(blob.media_ref).toBe(9999);
    expect(blob.key_fingerprint).toBe("sha256:abc123");
    expect(blob.blob_length).toBeGreaterThan(0);
    expect(blob.blob_preview).toBeTruthy();
    expect(blob.created_at).toBeTruthy();
  });

  it("returns multiple blobs for the same product", async () => {
    const channel = await createChannel();
    const media1 = await createMedia(channel.id, { name: "Video 1" });
    const media2 = await createMedia(channel.id, { name: "Video 2" });

    await createMediaProduct({
      mediaId: media1.id,
      satsrailProductId: "prod-multi-A",
      encryptedSource: "blob1-encrypted-content-here",
    });
    await createMediaProduct({
      mediaId: media2.id,
      satsrailProductId: "prod-multi-B",
      encryptedSource: "blob2-encrypted-content-here",
    });
    // Need a product with two blob rows to exercise the "multiple blobs per
    // product" path. A media-scoped Product is 1:1 with Media; channel-scoped
    // is N:M, so we create a channel product with two MediaEncryptedBlob entries.
    const cp = await createChannelProduct({
      channelId: channel.id,
      satsrailProductId: "prod-multi",
      encryptedMedia: [
        { mediaId: media1.id, encryptedSource: "blob1-encrypted-content-here" },
        { mediaId: media2.id, encryptedSource: "blob2-encrypted-content-here" },
      ],
    });

    const [req, ctx] = buildRequest("prod-multi");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);
    // touch cp to avoid unused
    expect(cp.id).toBeDefined();
  });

  it("returns the auth response when requireAdminApi rejects the request", async () => {
    vi.mocked(requireAdminApi).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const [req, ctx] = buildRequest("prod-anything");
    const res = await GET(req, ctx);
    expect(res.status).toBe(401);
  });

  it("truncates blob_preview correctly", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    const longBlob = "A".repeat(100);

    await createMediaProduct({
      mediaId: media.id,
      satsrailProductId: "prod-preview",
      encryptedSource: longBlob,
    });

    const [req, ctx] = buildRequest("prod-preview");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    const blob = body.data[0];
    expect(blob.blob_preview).toMatch(/^A{24}\.\.\.A{8}$/);
    expect(blob.blob_length).toBe(100);
  });
});
