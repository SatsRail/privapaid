import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "crypto";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { findFirstMediaProduct } from "../../helpers/factories";
import {
  base64urlToBytes,
  clientDecryptBlob,
  clientDecryptBytesWithKey,
  genProductKey,
  sha256HexOfString,
} from "../../helpers/crypto";

// ── Hoisted mocks (must come before route imports) ────────────────────

const FAKE_PORTAL_KEY = genProductKey();
const FAKE_PRODUCT_ID = "550e8400-e29b-41d4-a716-446655440000";
const FAKE_KEY_FINGERPRINT = await sha256HexOfString(FAKE_PORTAL_KEY);

const {
  mockRequireAdminApi,
  mockFileTypeFromBuffer,
  mockSharpMeta,
  mockSharpRotate,
  mockSharpToBuffer,
  mockSatsrailClient,
  mockGetMerchantKey,
  mockRateLimit,
} = vi.hoisted(() => {
  return {
    mockRequireAdminApi: vi.fn(),
    mockFileTypeFromBuffer: vi.fn(),
    mockSharpMeta: vi.fn(),
    mockSharpRotate: vi.fn(),
    mockSharpToBuffer: vi.fn(),
    mockSatsrailClient: {
      createProduct: vi.fn(),
      getProductKey: vi.fn(),
    },
    mockGetMerchantKey: vi.fn().mockResolvedValue("sk_live_test"),
    mockRateLimit: vi.fn().mockResolvedValue(null),
  };
});

const mockSharpInstance = {
  metadata: mockSharpMeta,
  rotate: mockSharpRotate,
  toBuffer: mockSharpToBuffer,
};

vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: mockRequireAdminApi,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/satsrail", () => ({ satsrail: mockSatsrailClient }));
vi.mock("@/lib/merchant-key", () => ({ getMerchantKey: mockGetMerchantKey }));
vi.mock("file-type", () => ({ fileTypeFromBuffer: mockFileTypeFromBuffer }));
vi.mock("sharp", () => ({
  default: vi.fn().mockImplementation(() => mockSharpInstance),
}));

// NOTE: deliberately NOT mocking @/lib/content-encryption — these tests
// exercise the real encryption code paths end-to-end.

import { NextRequest } from "next/server";
import { POST as adminPhotosPOST } from "@/app/api/admin/photos/route";
import { POST as adminMediaPOST } from "@/app/api/admin/media/route";
import { POST as createProductPOST } from "@/app/api/admin/media/[id]/create-product/route";
import { createChannel } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

// ── Helpers ───────────────────────────────────────────────────────────

function buildJsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(new URL(url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buildFormRequest(file: File): NextRequest {
  const fd = new FormData();
  fd.append("file", file);
  return new NextRequest(new URL("http://localhost:3000/api/admin/photos"), {
    method: "POST",
    body: fd,
  });
}

// ── Suite ─────────────────────────────────────────────────────────────

describe("Admin upload → store → decrypt with fake portal key", () => {
  beforeAll(async () => {
    await setupTestDB();
  });
  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(() => {
    mockRequireAdminApi.mockResolvedValue({
      id: "admin-1",
      email: "admin@test.com",
      role: "owner",
    });
    mockRateLimit.mockResolvedValue(null);
    mockFileTypeFromBuffer.mockResolvedValue({ mime: "image/jpeg", ext: "jpg" });
    mockSharpMeta.mockResolvedValue({ width: 800, height: 600 });
    mockSharpRotate.mockReturnValue(mockSharpInstance);

    mockSatsrailClient.createProduct.mockResolvedValue({
      id: FAKE_PRODUCT_ID,
      name: "Test Product",
      price_cents: 100,
      currency: "USD",
      access_duration_seconds: 86400,
      status: "active",
      slug: "test-product",
      external_ref: "md_1",
    });
    mockSatsrailClient.getProductKey.mockResolvedValue({
      key: FAKE_PORTAL_KEY,
      key_fingerprint: FAKE_KEY_FINGERPRINT,
    });
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------
  // ARTICLE
  // -------------------------------------------------------------------
  it("article: create-product encrypts sourceUrl with portal key; same key decrypts back to original markdown", async () => {
    const channel = await createChannel({
      slug: "showcase-article-e2e",
      satsrailProductTypeId: "pt_article",
    });
    const articleBody = [
      "# Lightning in a bottle",
      "",
      "Pay-walled article body — **markdown** with unicode: café 中文 🔥.",
      "",
      "- bullet",
      "- [link](https://example.com)",
    ].join("\n");

    const media = await prisma.media.create({
      data: {
        ref: 1,
        channelId: channel.id,
        name: "Article",
        blob: { kind: "markdown", body: articleBody },
        mediaType: "article",
      },
    });

    const req = buildJsonRequest(
      `http://localhost:3000/api/admin/media/${media.id}/create-product`,
      { name: "Article Product", price_cents: 1, access_duration_seconds: 86400 }
    );
    const res = await createProductPOST(req, { params: Promise.resolve({ id: media.id }) });
    expect(res.status).toBe(201);

    const stored = await findFirstMediaProduct({ mediaId: media.id });
    expect(stored).not.toBeNull();
    expect(stored!.satsrailProductId).toBe(FAKE_PRODUCT_ID);
    expect(stored!.keyFingerprint).toBe(FAKE_KEY_FINGERPRINT);
    expect(stored!.encryptedSourceUrl).toBeTruthy();

    const recovered = await clientDecryptBlob(
      stored!.encryptedSourceUrl,
      FAKE_PORTAL_KEY,
      FAKE_PRODUCT_ID
    );
    expect(new TextDecoder().decode(recovered)).toBe(articleBody);
  });

  it("article: a wrong (different) key cannot decrypt what create-product stored", async () => {
    const channel = await createChannel({
      slug: "showcase-article-wrongkey",
      satsrailProductTypeId: "pt_article2",
    });
    const media = await prisma.media.create({
      data: {
        ref: 2,
        channelId: channel.id,
        name: "Article 2",
        blob: { kind: "url", url: "Secret article body." },
        mediaType: "article",
      },
    });
    const req = buildJsonRequest(
      `http://localhost:3000/api/admin/media/${media.id}/create-product`,
      { name: "Article 2", price_cents: 1, access_duration_seconds: 86400 }
    );
    await createProductPOST(req, { params: Promise.resolve({ id: media.id }) });

    const stored = await findFirstMediaProduct({ mediaId: media.id });
    const wrongKey = genProductKey();

    await expect(
      clientDecryptBlob(stored!.encryptedSourceUrl, wrongKey, FAKE_PRODUCT_ID)
    ).rejects.toBeTruthy();
  });

  // -------------------------------------------------------------------
  // PHOTO — full envelope, including the upload + bytes
  // -------------------------------------------------------------------
  it("photo: upload → create-product → decrypt envelope with fake key → recover original image bytes", async () => {
    const originalPhoto = Buffer.from(
      Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        ...Buffer.from("FAKE-PNG-PAYLOAD-FOR-E2E-TEST"),
      ])
    );
    mockFileTypeFromBuffer.mockResolvedValue({ mime: "image/png", ext: "png" });
    mockSharpToBuffer.mockResolvedValue(originalPhoto);

    // Step 1 — POST /api/admin/photos with a PNG file.
    const file = new File([originalPhoto], "photo.png", { type: "image/png" });
    const uploadRes = await adminPhotosPOST(buildFormRequest(file));
    expect(uploadRes.status).toBe(201);
    const uploadBody = await uploadRes.json();
    expect(typeof uploadBody.dek).toBe("string");
    expect(uploadBody.mime).toBe("image/png");

    // Find the blob that was created
    const blob = await prisma.encryptedPhotoBlob.findFirst({ orderBy: { createdAt: "desc" } });
    expect(blob).not.toBeNull();
    const ciphertext = Buffer.from(blob!.bytes);
    expect(ciphertext.equals(originalPhoto)).toBe(false);
    expect(ciphertext.length).toBe(originalPhoto.length + 12 + 16);

    // Step 2 — register the Media (photo) pointing at the blob id.
    const channel = await createChannel({
      slug: "showcase-photo-e2e",
      satsrailProductTypeId: "pt_photo",
    });
    const media = await prisma.media.create({
      data: {
        ref: 3,
        channelId: channel.id,
        name: "Photo",
        blob: {
          kind: "photo",
          blobId: blob!.id,
          encryptedDek: "test_kek_wrapped_dek",
          mimeType: "image/png",
        },
        mediaType: "photo",
      },
    });

    // Step 3 — POST /api/admin/media/[id]/create-product with the DEK.
    const cpReq = buildJsonRequest(
      `http://localhost:3000/api/admin/media/${media.id}/create-product`,
      {
        name: "Photo Product",
        price_cents: 1,
        access_duration_seconds: 86400,
        dek: uploadBody.dek,
      }
    );
    const cpRes = await createProductPOST(cpReq, {
      params: Promise.resolve({ id: media.id }),
    });
    expect(cpRes.status).toBe(201);

    const stored = await findFirstMediaProduct({ mediaId: media.id });
    expect(stored).not.toBeNull();
    expect(stored!.keyFingerprint).toBe(FAKE_KEY_FINGERPRINT);

    // Sanity: wrapped DEK length is small, NOT the photo size.
    expect(stored!.encryptedSourceUrl.length).toBeLessThan(200);

    // Step 4 — unwrap the DEK envelope with the fake portal key.
    const innerBytes = await clientDecryptBlob(
      stored!.encryptedSourceUrl,
      FAKE_PORTAL_KEY,
      FAKE_PRODUCT_ID
    );
    const recoveredDekString = new TextDecoder().decode(innerBytes);
    expect(recoveredDekString).toBe(uploadBody.dek);

    // Step 5 — base64url-decode the DEK and decrypt the ciphertext.
    const dekBytes = base64urlToBytes(recoveredDekString);
    expect(dekBytes.length).toBe(32);
    const recoveredPhoto = await clientDecryptBytesWithKey(
      new Uint8Array(ciphertext),
      dekBytes
    );

    expect(Buffer.from(recoveredPhoto).equals(originalPhoto)).toBe(true);
  });

  it("photo: wrong portal key cannot unwrap the DEK envelope", async () => {
    const originalPhoto = Buffer.from(
      Uint8Array.from([
        0xff, 0xd8, 0xff, 0xe0,
        ...Buffer.from("FAKE-JPEG-PAYLOAD"),
      ])
    );
    mockSharpToBuffer.mockResolvedValue(originalPhoto);
    mockFileTypeFromBuffer.mockResolvedValue({ mime: "image/jpeg", ext: "jpg" });

    const file = new File([originalPhoto], "photo.jpg", { type: "image/jpeg" });
    const uploadRes = await adminPhotosPOST(buildFormRequest(file));
    const uploadBody = await uploadRes.json();

    const blob = await prisma.encryptedPhotoBlob.findFirst({ orderBy: { createdAt: "desc" } });
    const channel = await createChannel({
      slug: "showcase-photo-wrongkey",
      satsrailProductTypeId: "pt_photo2",
    });
    const media = await prisma.media.create({
      data: {
        ref: 4,
        channelId: channel.id,
        name: "Photo Wrong Key",
        blob: {
          kind: "photo",
          blobId: blob!.id,
          encryptedDek: "test_kek_wrapped_dek",
          mimeType: "image/png",
        },
        mediaType: "photo",
      },
    });
    const cpReq = buildJsonRequest(
      `http://localhost:3000/api/admin/media/${media.id}/create-product`,
      {
        name: "Photo Wrong Key",
        price_cents: 1,
        access_duration_seconds: 86400,
        dek: uploadBody.dek,
      }
    );
    await createProductPOST(cpReq, {
      params: Promise.resolve({ id: media.id }),
    });

    const stored = await findFirstMediaProduct({ mediaId: media.id });
    const wrongKey = genProductKey();

    await expect(
      clientDecryptBlob(stored!.encryptedSourceUrl, wrongKey, FAKE_PRODUCT_ID)
    ).rejects.toBeTruthy();
  });

  it("photo: ciphertext cannot be decrypted with the WRONG DEK", async () => {
    const originalPhoto = Buffer.from(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...Buffer.from("payload")])
    );
    mockFileTypeFromBuffer.mockResolvedValue({ mime: "image/png", ext: "png" });
    mockSharpToBuffer.mockResolvedValue(originalPhoto);

    const file = new File([originalPhoto], "photo.png", { type: "image/png" });
    await adminPhotosPOST(buildFormRequest(file));

    const blob = await prisma.encryptedPhotoBlob.findFirst({ orderBy: { createdAt: "desc" } });
    const ciphertext = Buffer.from(blob!.bytes);
    const wrongDek = randomBytes(32);
    await expect(
      clientDecryptBytesWithKey(new Uint8Array(ciphertext), wrongDek)
    ).rejects.toBeTruthy();
  });

  // -------------------------------------------------------------------
  it("article: fingerprint stored on MediaProduct matches SHA-256(portal key)", async () => {
    const channel = await createChannel({
      slug: "fp-check",
      satsrailProductTypeId: "pt_fp",
    });
    const media = await prisma.media.create({
      data: {
        ref: 5,
        channelId: channel.id,
        name: "Fingerprint check",
        blob: { kind: "url", url: "irrelevant body" },
        mediaType: "article",
      },
    });
    const req = buildJsonRequest(
      `http://localhost:3000/api/admin/media/${media.id}/create-product`,
      { name: "FP", price_cents: 1, access_duration_seconds: 86400 }
    );
    await createProductPOST(req, { params: Promise.resolve({ id: media.id }) });

    const stored = await findFirstMediaProduct({ mediaId: media.id });
    expect(stored!.keyFingerprint).toBe(FAKE_KEY_FINGERPRINT);
    const clientComputed = await sha256HexOfString(FAKE_PORTAL_KEY);
    expect(stored!.keyFingerprint).toBe(clientComputed);
  });
});

// Silence unused-warning while keeping the import for future tests.
void adminMediaPOST;
