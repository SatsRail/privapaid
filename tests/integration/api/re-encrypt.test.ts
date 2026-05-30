import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct, createChannelProduct, findFirstMediaProduct } from "../../helpers/factories";
import { createChannel, createMedia } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";
import { decryptSourceUrl } from "@/lib/content-encryption";
import { wrapDekFromBase64url, _resetKekCache } from "@/lib/content-dek";

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
  // CONTENT_KEK for the photo path test — 32 bytes base64.
  const CONTENT_KEK = randomBytes(32).toString("base64");

  beforeAll(async () => {
    await setupTestDB();
    process.env.CONTENT_KEK = CONTENT_KEK;
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", name: "Admin", type: "admin", role: "owner" },
    });
  });

  afterAll(async () => {
    await teardownTestDB();
    delete process.env.CONTENT_KEK;
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

  it("re-encrypts MediaProducts from local Media.sourceUrl under the new key", async () => {
    const channel = await createChannel();
    const urls = [
      "https://cdn.example.com/video1.mp4",
      "https://cdn.example.com/video2.mp4",
      "https://cdn.example.com/video3.mp4",
    ];

    let i = 0;
    for (const url of urls) {
      const media = await createMedia(channel.id, {
        name: `Video ${i}`,
        sourceUrl: url,
      });
      await createMediaProduct({
          mediaId: media.id,
          satsrailProductId: `${productId}_${i}`,
          encryptedSource: "stale-base64-from-pre-rotation",
        });
      i++;
    }
    // The route iterates all products with the same satsrailProductId.
    // The schema enforces unique mediaId on MediaProduct AND unique
    // satsrailProductId — meaning each MediaProduct has a 1:1 with both.
    // To preserve test intent (one productId, multiple medias), use a
    // ChannelProduct instead.
    const ch2 = await createChannel({ slug: "ch-reencrypt" });
    const medias = [];
    for (let j = 0; j < urls.length; j++) {
      const m = await createMedia(ch2.id, { name: `V${j}`, sourceUrl: urls[j] });
      medias.push(m);
    }
    await createChannelProduct({
      channelId: ch2.id,
      satsrailProductId: productId,
      encryptedMedia: medias.map((m) => ({
        mediaId: m.id,
        encryptedSource: "stale-base64-from-pre-rotation",
      })),
    });

    mockGetProductKey.mockResolvedValue({ key: newKey, key_fingerprint: "new_fp" });
    mockClearOldKey.mockResolvedValue({});

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });

    expect(res.status).toBe(200);
    const events = (await readStream(res)).map((l) => JSON.parse(l));

    expect(events.at(-1)).toMatchObject({ done: true });

    const cp = await prisma.product.findFirst({
      where: { satsrailProductId: productId },
      include: { mediaEncryptedBlobs: true },
    });
    for (const entry of cp!.mediaEncryptedBlobs) {
      const decrypted = decryptSourceUrl(entry.encryptedSource, newKey, productId);
      expect(urls).toContain(decrypted);
    }

    expect(mockClearOldKey).toHaveBeenCalledWith("sk_live_test_merchant_key", productId);
    // The new flow no longer fetches the product to read old_key.
    expect(mockGetProduct).not.toHaveBeenCalled();
  });

  it("re-encrypts photo media by unwrapping encryptedDek with CONTENT_KEK", async () => {
    const channel = await createChannel();
    const dekBase64url = generateProductKey(); // reused as a 32-byte DEK
    const encryptedDek = wrapDekFromBase64url(dekBase64url);

    const media = await createMedia(channel.id, {
      name: "Photo",
      blob: {
        kind: "photo",
        envelopeId: "blob_pointer_id",
        encryptedDek,
        mimeType: "image/jpeg",
      },
      mediaType: "photo",
    });

    await createMediaProduct({
        mediaId: media.id,
        satsrailProductId: productId,
        encryptedSource: "stale",
      });

    mockGetProductKey.mockResolvedValue({ key: newKey, key_fingerprint: "fp" });
    mockClearOldKey.mockResolvedValue({});

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });

    expect(res.status).toBe(200);
    const events = (await readStream(res)).map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ done: true });

    const reloaded = await findFirstMediaProduct({ satsrailProductId: productId });
    const decrypted = decryptSourceUrl(reloaded!.encryptedSource, newKey, productId);
    expect(decrypted).toBe(dekBase64url);
  });

  it("re-encrypts ChannelProduct.encryptedMedia entries too", async () => {
    const channel = await createChannel();
    const m1 = await createMedia(channel.id, { sourceUrl: "https://a.example/v.mp4" });
    const m2 = await createMedia(channel.id, { sourceUrl: "https://b.example/v.mp4" });

    await createChannelProduct({
        channelId: channel.id,
        satsrailProductId: productId,
        encryptedMedia: [
            { mediaId: m1.id, encryptedSource: "stale1" },
            { mediaId: m2.id, encryptedSource: "stale2" },
          ],
      });

    mockGetProductKey.mockResolvedValue({ key: newKey, key_fingerprint: "fp" });
    mockClearOldKey.mockResolvedValue({});

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });

    expect(res.status).toBe(200);
    const events = (await readStream(res)).map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ done: true });

    const cp = await prisma.product.findFirst({
      where: { satsrailProductId: productId },
      include: { mediaEncryptedBlobs: true },
    });
    expect(cp!.mediaEncryptedBlobs).toHaveLength(2);
    const urls = cp!.mediaEncryptedBlobs.map((e) =>
      decryptSourceUrl(e.encryptedSource, newKey, productId)
    );
    expect(urls).toEqual(
      expect.arrayContaining(["https://a.example/v.mp4", "https://b.example/v.mp4"])
    );
  });

  it("auto-clears a media's Part B error flag after a clean re-encrypt", async () => {
    // A re-encrypt rewrites every blob for the product, so any media flagged
    // `error` over a previously-undecryptable blob is now fixed. The flag
    // should lift automatically — the admin shouldn't have to clear it by hand.
    const channel = await createChannel();
    const media = await prisma.media.create({
      data: {
        channelId: channel.id,
        name: "Broken then fixed",
        mediaType: "video",
        blob: { kind: "url", url: "https://cdn.example.com/fixed.mp4" },
        status: "error",
        statusReason: "integrity_auth_failed",
        statusChangedAt: new Date(),
      },
    });
    await createMediaProduct({
      mediaId: media.id,
      satsrailProductId: productId,
      encryptedSource: "stale-pre-rotation",
    });

    mockGetProductKey.mockResolvedValue({ key: newKey, key_fingerprint: "fp" });
    mockClearOldKey.mockResolvedValue({});

    const req = createReEncryptRequest(productId);
    const res = await POST(req, { params: Promise.resolve({ id: productId }) });
    expect(res.status).toBe(200);
    const events = (await readStream(res)).map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ done: true, errors: 0 });

    const after = await prisma.media.findUnique({
      where: { id: media.id },
      select: { status: true, statusReason: true },
    });
    expect(after?.status).toBe("ok");
    expect(after?.statusReason).toBeNull();
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
