import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose, { Types } from "mongoose";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";
import { createChannel, createMedia } from "../../helpers/factories";

// Mock rate limit
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

// Mock connectDB
vi.mock("@/lib/mongodb", () => ({
  connectDB: vi.fn().mockImplementation(async () => mongoose),
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
import MediaProduct from "@/models/MediaProduct";
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
    const media = await createMedia(String(channel._id), {
      name: "Encrypted Video",
      media_type: "video",
      ref: 9999,
    });

    await MediaProduct.create({
      media_id: media._id,
      satsrail_product_id: "prod-456",
      encrypted_source_url: "aes256gcm:abcdefghijklmnopqrstuvwxyz1234567890abcdef",
      key_fingerprint: "sha256:abc123",
    });

    const [req, ctx] = buildRequest("prod-456");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);

    const blob = body.data[0];
    expect(blob.media_id).toBe(String(media._id));
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
    const media1 = await createMedia(String(channel._id), { name: "Video 1" });
    const media2 = await createMedia(String(channel._id), { name: "Video 2" });

    await MediaProduct.create({
      media_id: media1._id,
      satsrail_product_id: "prod-multi",
      encrypted_source_url: "blob1-encrypted-content-here",
    });
    await MediaProduct.create({
      media_id: media2._id,
      satsrail_product_id: "prod-multi",
      encrypted_source_url: "blob2-encrypted-content-here",
    });

    const [req, ctx] = buildRequest("prod-multi");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);
  });

  it("handles media products whose media has been deleted", async () => {
    const deletedMediaId = new Types.ObjectId();

    await MediaProduct.create({
      media_id: deletedMediaId,
      satsrail_product_id: "prod-orphan",
      encrypted_source_url: "orphan-blob-data",
    });

    const [req, ctx] = buildRequest("prod-orphan");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].media_name).toBe("Unknown");
    expect(body.data[0].media_type).toBe("unknown");
    expect(body.data[0].media_ref).toBeNull();
  });

  it("returns the auth response when requireAdminApi rejects the request", async () => {
    vi.mocked(requireAdminApi).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const [req, ctx] = buildRequest("prod-anything");
    const res = await GET(req, ctx);
    expect(res.status).toBe(401);
  });

  it("renders null blob_preview and zero blob_length when encrypted_source_url is missing", async () => {
    const channel = await createChannel();
    const media = await createMedia(String(channel._id));

    // Insert the document with no encrypted_source_url. The schema marks
    // the field required, so we go through the raw collection to bypass
    // validation — the route must still gracefully handle legacy rows.
    await MediaProduct.collection.insertOne({
      media_id: media._id,
      satsrail_product_id: "prod-missing-blob",
      created_at: new Date(),
      updated_at: new Date(),
    });

    const [req, ctx] = buildRequest("prod-missing-blob");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    const blob = body.data[0];
    expect(blob.blob_preview).toBeNull();
    expect(blob.blob_length).toBe(0);
    expect(blob.key_fingerprint).toBeNull();
  });

  it("renders null created_at when the MediaProduct has no timestamp", async () => {
    const channel = await createChannel();
    const media = await createMedia(String(channel._id));

    // Raw insert again — bypasses Mongoose timestamps so created_at is
    // genuinely absent and the route hits its `created_at ? ... : null`
    // else branch.
    await MediaProduct.collection.insertOne({
      media_id: media._id,
      satsrail_product_id: "prod-no-ts",
      encrypted_source_url: "blob-bytes",
    });

    const [req, ctx] = buildRequest("prod-no-ts");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data[0].created_at).toBeNull();
  });

  it("truncates blob_preview correctly", async () => {
    const channel = await createChannel();
    const media = await createMedia(String(channel._id));
    const longBlob = "A".repeat(100);

    await MediaProduct.create({
      media_id: media._id,
      satsrail_product_id: "prod-preview",
      encrypted_source_url: longBlob,
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
