import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { randomBytes } from "crypto";
import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";
import { createChannel, createMedia } from "../../helpers/factories";
import MediaProduct from "@/models/MediaProduct";
import ChannelProduct from "@/models/ChannelProduct";
import Media from "@/models/Media";
import { encryptSourceUrl, decryptSourceUrl } from "@/lib/content-encryption";
import { wrapDekFromBase64url, _resetKekCache } from "@/lib/photo-dek";

function generateProductKey(): string {
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectDB: vi.fn().mockImplementation(async () => mongoose),
}));

const mockGetProduct = vi.fn();
const mockGetProductKey = vi.fn();
const mockClearOldKey = vi.fn();

vi.mock("@/lib/satsrail", () => ({
  satsrail: {
    getProduct: (...args: unknown[]) => mockGetProduct(...args),
    getProductKey: (...args: unknown[]) => mockGetProductKey(...args),
    clearOldKey: (...args: unknown[]) => mockClearOldKey(...args),
  },
}));

vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: vi.fn().mockResolvedValue("sk_live_test_merchant_key"),
}));

import { POST } from "@/app/api/admin/products/[id]/re-encrypt/route";

async function readStream(response: Response): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    const chunkLines = chunk.split("\n").filter(Boolean);
    lines.push(...chunkLines);
  }

  return lines;
}

function createReEncryptRequest(productId: string): NextRequest {
  return new NextRequest(
    new URL(`http://localhost:3000/api/admin/products/${productId}/re-encrypt`),
    { method: "POST" }
  );
}

describe("POST /api/admin/products/[id]/re-encrypt", () => {
  const newKey = generateProductKey();
  const productId = "prod_test_rotation";
  // PHOTO_KEK for the photo path test — 32 bytes base64.
  const PHOTO_KEK = randomBytes(32).toString("base64");

  beforeAll(async () => {
    await setupTestDB();
    process.env.PHOTO_KEK = PHOTO_KEK;
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", name: "Admin", type: "admin", role: "owner" },
    });
  });

  afterAll(async () => {
    await teardownTestDB();
    delete process.env.PHOTO_KEK;
    _resetKekCache();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    _resetKekCache();
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", name: "Admin", type: "admin", role: "owner" },
    });
  });

  it("re-encrypts MediaProducts from local Media.source_url under the new key", async () => {
    const channel = await createChannel();
    const urls = [
      "https://cdn.example.com/video1.mp4",
      "https://cdn.example.com/video2.mp4",
      "https://cdn.example.com/video3.mp4",
    ];

    for (let i = 0; i < urls.length; i++) {
      const media = await createMedia(channel._id.toString(), {
        name: `Video ${i}`,
        source_url: urls[i],
      });
      await MediaProduct.create({
        media_id: media._id,
        satsrail_product_id: productId,
        // The OLD ciphertext doesn't matter — we re-encrypt from plaintext.
        encrypted_source_url: "stale-base64-from-pre-rotation",
      });
    }

    mockGetProductKey.mockResolvedValue({ key: newKey, key_fingerprint: "new_fp" });
    mockClearOldKey.mockResolvedValue({});

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });

    expect(res.status).toBe(200);
    const events = (await readStream(res)).map((l) => JSON.parse(l));

    expect(events).toHaveLength(4);
    expect(events[3]).toEqual({ done: true, total: 3, errors: 0 });

    const mediaProducts = await MediaProduct.find({ satsrail_product_id: productId });
    for (const mp of mediaProducts) {
      const decrypted = decryptSourceUrl(mp.encrypted_source_url, newKey, productId);
      expect(urls).toContain(decrypted);
    }

    expect(mockClearOldKey).toHaveBeenCalledWith("sk_live_test_merchant_key", productId);
    // The new flow no longer fetches the product to read old_key.
    expect(mockGetProduct).not.toHaveBeenCalled();
  });

  it("re-encrypts photo media by unwrapping encrypted_dek with PHOTO_KEK", async () => {
    const channel = await createChannel();
    const dekBase64url = generateProductKey(); // reused as a 32-byte DEK
    const encryptedDek = wrapDekFromBase64url(dekBase64url);

    const media = await createMedia(channel._id.toString(), {
      name: "Photo",
      source_url: "gridfs_pointer_id",
      media_type: "photo",
    });
    await Media.findByIdAndUpdate(media._id, { encrypted_dek: encryptedDek });

    await MediaProduct.create({
      media_id: media._id,
      satsrail_product_id: productId,
      encrypted_source_url: "stale",
    });

    mockGetProductKey.mockResolvedValue({ key: newKey, key_fingerprint: "fp" });
    mockClearOldKey.mockResolvedValue({});

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });

    expect(res.status).toBe(200);
    const events = (await readStream(res)).map((l) => JSON.parse(l));
    expect(events.at(-1)).toEqual({ done: true, total: 1, errors: 0 });

    const reloaded = await MediaProduct.findOne({ satsrail_product_id: productId });
    const decrypted = decryptSourceUrl(reloaded!.encrypted_source_url, newKey, productId);
    expect(decrypted).toBe(dekBase64url);
  });

  it("re-encrypts ChannelProduct.encrypted_media entries too", async () => {
    const channel = await createChannel();
    const m1 = await createMedia(channel._id.toString(), {
      source_url: "https://a.example/v.mp4",
    });
    const m2 = await createMedia(channel._id.toString(), {
      source_url: "https://b.example/v.mp4",
    });

    await ChannelProduct.create({
      channel_id: channel._id,
      satsrail_product_id: productId,
      encrypted_media: [
        { media_id: m1._id, encrypted_source_url: "stale1" },
        { media_id: m2._id, encrypted_source_url: "stale2" },
      ],
    });

    mockGetProductKey.mockResolvedValue({ key: newKey, key_fingerprint: "fp" });
    mockClearOldKey.mockResolvedValue({});

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });

    expect(res.status).toBe(200);
    const events = (await readStream(res)).map((l) => JSON.parse(l));
    expect(events.at(-1)).toEqual({ done: true, total: 2, errors: 0 });

    const cp = await ChannelProduct.findOne({ satsrail_product_id: productId });
    expect(cp!.encrypted_media).toHaveLength(2);
    const urls = cp!.encrypted_media.map((e) =>
      decryptSourceUrl(e.encrypted_source_url, newKey, productId)
    );
    expect(urls).toEqual(
      expect.arrayContaining(["https://a.example/v.mp4", "https://b.example/v.mp4"])
    );
  });

  it("clears old_key immediately when no work exists", async () => {
    mockGetProductKey.mockResolvedValue({ key: newKey, key_fingerprint: "fp" });
    mockClearOldKey.mockResolvedValue({});

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });

    const body = await res.json();
    expect(body).toEqual({ done: true, total: 0, errors: 0 });
    expect(mockClearOldKey).toHaveBeenCalledWith("sk_live_test_merchant_key", productId);
  });

  it("counts an error and does NOT clear old_key when a Media row is missing", async () => {
    const channel = await createChannel();
    const m = await createMedia(channel._id.toString(), {
      source_url: "https://gone.example/v.mp4",
    });
    await MediaProduct.create({
      media_id: m._id,
      satsrail_product_id: productId,
      encrypted_source_url: "stale",
    });

    // Simulate Media deletion between the find() above and the loop body
    // by deleting the doc through the model so the in-loop lookup misses.
    await Media.deleteOne({ _id: m._id });

    mockGetProductKey.mockResolvedValue({ key: newKey, key_fingerprint: "fp" });

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });

    const events = (await readStream(res)).map((l) => JSON.parse(l));
    const done = events.find((e: { done?: boolean }) => e.done);
    expect(done.errors).toBeGreaterThan(0);
    expect(mockClearOldKey).not.toHaveBeenCalled();
  });

  it("counts an error for photo media missing encrypted_dek", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel._id.toString(), {
      source_url: "gridfs_id",
      media_type: "photo",
    });
    // Note: NO encrypted_dek set.

    await MediaProduct.create({
      media_id: media._id,
      satsrail_product_id: productId,
      encrypted_source_url: "stale",
    });

    mockGetProductKey.mockResolvedValue({ key: newKey, key_fingerprint: "fp" });

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });

    const events = (await readStream(res)).map((l) => JSON.parse(l));
    const done = events.find((e: { done?: boolean }) => e.done);
    expect(done.errors).toBeGreaterThan(0);
    expect(mockClearOldKey).not.toHaveBeenCalled();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });

    expect(res.status).toBe(401);
  });

  it("returns 403 when admin but not owner", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-2", email: "mgr@test.com", name: "Manager", type: "admin", role: "admin" },
    });

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });

    expect(res.status).toBe(403);
  });

  it("returns 502 when SatsRail getProductKey fails", async () => {
    mockGetProductKey.mockRejectedValue(new Error("Key service down"));

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("Key service down");
  });

  it("returns 422 when merchant key is not configured", async () => {
    const { getMerchantKey } = await import("@/lib/merchant-key");
    (getMerchantKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("Merchant API key not configured");
  });

  // Suppress NextResponse import warning.
  it("noop sanity check", () => {
    expect(NextResponse).toBeDefined();
  });
});
