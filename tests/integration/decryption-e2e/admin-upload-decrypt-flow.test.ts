import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { randomBytes } from "crypto";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";
import {
  base64urlToBytes,
  bytesToBase64url,
  clientDecryptBlob,
  clientDecryptBytesWithKey,
  genProductKey,
  sha256HexOfString,
} from "../../helpers/crypto";

/**
 * Full admin upload → decrypt round-trip specs.
 *
 * These tests drive the REAL admin HTTP endpoints — `/api/admin/photos`,
 * `/api/admin/media`, `/api/admin/media/[id]/create-product` — using
 * the REAL `encryptSourceUrl` and `encryptBytes` primitives, then
 * decrypt whatever the endpoints persisted using the fake portal key
 * we handed them via the mocked SatsRail client.
 *
 * If the admin flow ever drifts (wrong key used at wrap time, missing
 * AAD, wrong base64url canonicalization, swapped IV/tag layout, etc.)
 * the round-trip below breaks loudly and prints the exact mismatch.
 *
 * The "fake key" is the SatsRail product key — it is fake in the sense
 * that the test controls it deterministically via the mock, not in the
 * sense that the encryption is fake. All AES-256-GCM operations are real.
 */

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
  mockBucketOpenUploadStream,
  mockGridFsCapturedBytes,
  mockSatsrailClient,
  mockGetMerchantKey,
  mockRateLimit,
} = vi.hoisted(() => {
  const capturedBytes: { value: Buffer | null } = { value: null };
  return {
    mockRequireAdminApi: vi.fn(),
    mockFileTypeFromBuffer: vi.fn(),
    mockSharpMeta: vi.fn(),
    mockSharpRotate: vi.fn(),
    mockSharpToBuffer: vi.fn(),
    mockBucketOpenUploadStream: vi.fn(),
    mockGridFsCapturedBytes: capturedBytes,
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
vi.mock("@/lib/mongodb", () => ({
  connectDB: vi.fn().mockImplementation(async () => mongoose),
}));
vi.mock("@/lib/satsrail", () => ({ satsrail: mockSatsrailClient }));
vi.mock("@/lib/merchant-key", () => ({ getMerchantKey: mockGetMerchantKey }));
vi.mock("@/lib/gridfs", () => ({
  getEncryptedPhotosBucket: vi.fn().mockResolvedValue({
    openUploadStream: mockBucketOpenUploadStream,
  }),
  ALLOWED_IMAGE_TYPES: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  MAX_IMAGE_SIZE: 5 * 1024 * 1024,
}));
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
import Media from "@/models/Media";
import MediaProduct from "@/models/MediaProduct";

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
    // JPEG default; PNG override in the PNG-specific test
    mockFileTypeFromBuffer.mockResolvedValue({ mime: "image/jpeg", ext: "jpg" });
    mockSharpMeta.mockResolvedValue({ width: 800, height: 600 });
    mockSharpRotate.mockReturnValue(mockSharpInstance);

    // GridFS upload mock: capture the bytes the route writes.
    mockGridFsCapturedBytes.value = null;
    const uploadStream = {
      id: { toString: () => "gridfs_photo_id_e2e" },
      on: vi.fn().mockImplementation((event: string, cb: () => void) => {
        if (event === "finish") setTimeout(cb, 0);
      }),
      end: vi.fn().mockImplementation((bytes: Buffer) => {
        mockGridFsCapturedBytes.value = bytes;
      }),
    };
    mockBucketOpenUploadStream.mockReturnValue(uploadStream);

    // Mocked SatsRail portal: createProduct returns a deterministic product,
    // getProductKey returns the FAKE PORTAL KEY this test will decrypt with.
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
  it("article: create-product encrypts source_url with portal key; same key decrypts back to original markdown", async () => {
    const channel = await createChannel({
      slug: "showcase-article-e2e",
      satsrail_product_type_id: "pt_article",
    });
    const articleBody = [
      "# Lightning in a bottle",
      "",
      "Pay-walled article body — **markdown** with unicode: café 中文 🔥.",
      "",
      "- bullet",
      "- [link](https://example.com)",
    ].join("\n");

    const media = await Media.create({
      ref: 1,
      channel_id: channel._id,
      name: "Article",
      source_url: articleBody,
      media_type: "article",
    });

    // Drive the real create-product route — wraps `source_url` under FAKE_PORTAL_KEY.
    const req = buildJsonRequest(
      `http://localhost:3000/api/admin/media/${media._id}/create-product`,
      { name: "Article Product", price_cents: 1, access_duration_seconds: 86400 }
    );
    const res = await createProductPOST(req, { params: Promise.resolve({ id: String(media._id) }) });
    expect(res.status).toBe(201);

    const stored = await MediaProduct.findOne({ media_id: media._id }).lean();
    expect(stored).not.toBeNull();
    expect(stored!.satsrail_product_id).toBe(FAKE_PRODUCT_ID);
    expect(stored!.key_fingerprint).toBe(FAKE_KEY_FINGERPRINT);
    expect(stored!.encrypted_source_url).toBeTruthy();

    // Decrypt with the fake portal key + productId AAD — same path the
    // browser runs in PaymentWall.resolveContent for non-photo media.
    const recovered = await clientDecryptBlob(
      stored!.encrypted_source_url,
      FAKE_PORTAL_KEY,
      FAKE_PRODUCT_ID
    );
    expect(new TextDecoder().decode(recovered)).toBe(articleBody);
  });

  it("article: a wrong (different) key cannot decrypt what create-product stored", async () => {
    const channel = await createChannel({
      slug: "showcase-article-wrongkey",
      satsrail_product_type_id: "pt_article2",
    });
    const media = await Media.create({
      ref: 2,
      channel_id: channel._id,
      name: "Article 2",
      source_url: "Secret article body.",
      media_type: "article",
    });
    const req = buildJsonRequest(
      `http://localhost:3000/api/admin/media/${media._id}/create-product`,
      { name: "Article 2", price_cents: 1, access_duration_seconds: 86400 }
    );
    await createProductPOST(req, { params: Promise.resolve({ id: String(media._id) }) });

    const stored = await MediaProduct.findOne({ media_id: media._id }).lean();
    const wrongKey = genProductKey();

    await expect(
      clientDecryptBlob(stored!.encrypted_source_url, wrongKey, FAKE_PRODUCT_ID)
    ).rejects.toBeTruthy();
  });

  // -------------------------------------------------------------------
  // PHOTO — full envelope, including the upload + GridFS bytes
  // -------------------------------------------------------------------
  it("photo: upload → create-product → decrypt envelope with fake key → recover original image bytes", async () => {
    const originalPhoto = Buffer.from(
      Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        ...Buffer.from("FAKE-PNG-PAYLOAD-FOR-E2E-TEST"),
      ])
    );
    mockFileTypeFromBuffer.mockResolvedValue({ mime: "image/png", ext: "png" });
    // sharp returns the "EXIF-stripped" buffer that gets encrypted. Using the
    // ORIGINAL bytes here so the round-trip can assert byte equality.
    mockSharpToBuffer.mockResolvedValue(originalPhoto);

    // Step 1 — POST /api/admin/photos with a PNG file.
    const file = new File([originalPhoto], "photo.png", { type: "image/png" });
    const uploadRes = await adminPhotosPOST(buildFormRequest(file));
    expect(uploadRes.status).toBe(201);
    const uploadBody = await uploadRes.json();
    expect(uploadBody.gridFsId).toBe("gridfs_photo_id_e2e");
    expect(typeof uploadBody.dek).toBe("string");
    expect(uploadBody.mime).toBe("image/png");

    // GridFS captured the ciphertext (no plaintext at rest).
    const ciphertext = mockGridFsCapturedBytes.value!;
    expect(ciphertext).toBeTruthy();
    expect(ciphertext.equals(originalPhoto)).toBe(false);
    expect(ciphertext.length).toBe(originalPhoto.length + 12 + 16); // IV + tag overhead

    // Step 2 — register the Media (photo) pointing at the GridFS id.
    const channel = await createChannel({
      slug: "showcase-photo-e2e",
      satsrail_product_type_id: "pt_photo",
    });
    const media = await Media.create({
      ref: 3,
      channel_id: channel._id,
      name: "Photo",
      source_url: uploadBody.gridFsId, // for photos, source_url IS the GridFS id
      media_type: "photo",
    });

    // Step 3 — POST /api/admin/media/[id]/create-product with the DEK.
    // The route wraps the DEK under the portal key (envelope encryption).
    const cpReq = buildJsonRequest(
      `http://localhost:3000/api/admin/media/${media._id}/create-product`,
      {
        name: "Photo Product",
        price_cents: 1,
        access_duration_seconds: 86400,
        dek: uploadBody.dek,
      }
    );
    const cpRes = await createProductPOST(cpReq, {
      params: Promise.resolve({ id: String(media._id) }),
    });
    expect(cpRes.status).toBe(201);

    const stored = await MediaProduct.findOne({ media_id: media._id }).lean();
    expect(stored).not.toBeNull();
    expect(stored!.key_fingerprint).toBe(FAKE_KEY_FINGERPRINT);

    // Sanity: wrapped DEK length is small (~96 chars base64), NOT the photo size.
    expect(stored!.encrypted_source_url.length).toBeLessThan(200);

    // Step 4 — unwrap the DEK envelope with the fake portal key.
    const innerBytes = await clientDecryptBlob(
      stored!.encrypted_source_url,
      FAKE_PORTAL_KEY,
      FAKE_PRODUCT_ID
    );
    const recoveredDekString = new TextDecoder().decode(innerBytes);
    expect(recoveredDekString).toBe(uploadBody.dek);

    // Step 5 — base64url-decode the DEK and decrypt the GridFS ciphertext.
    const dekBytes = base64urlToBytes(recoveredDekString);
    expect(dekBytes.length).toBe(32);
    const recoveredPhoto = await clientDecryptBytesWithKey(
      new Uint8Array(ciphertext),
      dekBytes
    );

    // Step 6 — bytes must match exactly. If they don't, the photo is unrecoverable.
    expect(Buffer.from(recoveredPhoto).equals(originalPhoto)).toBe(true);
  });

  it("photo: wrong portal key cannot unwrap the DEK envelope", async () => {
    const originalPhoto = Buffer.from(
      Uint8Array.from([
        0xff, 0xd8, 0xff, 0xe0, // JPEG SOI + APP0
        ...Buffer.from("FAKE-JPEG-PAYLOAD"),
      ])
    );
    mockSharpToBuffer.mockResolvedValue(originalPhoto);
    mockFileTypeFromBuffer.mockResolvedValue({ mime: "image/jpeg", ext: "jpg" });

    const file = new File([originalPhoto], "photo.jpg", { type: "image/jpeg" });
    const uploadRes = await adminPhotosPOST(buildFormRequest(file));
    const uploadBody = await uploadRes.json();

    const channel = await createChannel({
      slug: "showcase-photo-wrongkey",
      satsrail_product_type_id: "pt_photo2",
    });
    const media = await Media.create({
      ref: 4,
      channel_id: channel._id,
      name: "Photo Wrong Key",
      source_url: uploadBody.gridFsId,
      media_type: "photo",
    });
    const cpReq = buildJsonRequest(
      `http://localhost:3000/api/admin/media/${media._id}/create-product`,
      {
        name: "Photo Wrong Key",
        price_cents: 1,
        access_duration_seconds: 86400,
        dek: uploadBody.dek,
      }
    );
    await createProductPOST(cpReq, {
      params: Promise.resolve({ id: String(media._id) }),
    });

    const stored = await MediaProduct.findOne({ media_id: media._id }).lean();
    const wrongKey = genProductKey();

    await expect(
      clientDecryptBlob(stored!.encrypted_source_url, wrongKey, FAKE_PRODUCT_ID)
    ).rejects.toBeTruthy();
  });

  it("photo: GridFS ciphertext cannot be decrypted with the WRONG DEK", async () => {
    // Confirms the envelope binds the photo bytes to the SPECIFIC DEK
    // returned by the upload — not just any 32-byte key.
    const originalPhoto = Buffer.from(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...Buffer.from("payload")])
    );
    mockFileTypeFromBuffer.mockResolvedValue({ mime: "image/png", ext: "png" });
    mockSharpToBuffer.mockResolvedValue(originalPhoto);

    const file = new File([originalPhoto], "photo.png", { type: "image/png" });
    await adminPhotosPOST(buildFormRequest(file));

    const ciphertext = mockGridFsCapturedBytes.value!;
    const wrongDek = randomBytes(32);
    await expect(
      clientDecryptBytesWithKey(new Uint8Array(ciphertext), wrongDek)
    ).rejects.toBeTruthy();
  });

  // -------------------------------------------------------------------
  // Cross-product article (channel-level products that wrap on creation)
  // -------------------------------------------------------------------
  it("article: fingerprint stored on MediaProduct matches SHA-256(portal key)", async () => {
    // Pins the fingerprint computation contract — PaymentWall's
    // `verifyKeyFingerprint(data.key, product.keyFingerprint)` MUST pass
    // when the portal returns the same key it returned at create-product
    // time. If portal-side and stored sha256 differ for any reason, every
    // payment for this product would record `PaymentWall.fingerprint`
    // failures.
    const channel = await createChannel({
      slug: "fp-check",
      satsrail_product_type_id: "pt_fp",
    });
    const media = await Media.create({
      ref: 5,
      channel_id: channel._id,
      name: "Fingerprint check",
      source_url: "irrelevant body",
      media_type: "article",
    });
    const req = buildJsonRequest(
      `http://localhost:3000/api/admin/media/${media._id}/create-product`,
      { name: "FP", price_cents: 1, access_duration_seconds: 86400 }
    );
    await createProductPOST(req, { params: Promise.resolve({ id: String(media._id) }) });

    const stored = await MediaProduct.findOne({ media_id: media._id }).lean();
    expect(stored!.key_fingerprint).toBe(FAKE_KEY_FINGERPRINT);
    // Also confirm the fingerprint is what the CLIENT would compute from the same key.
    const clientComputed = await sha256HexOfString(FAKE_PORTAL_KEY);
    expect(stored!.key_fingerprint).toBe(clientComputed);
  });
});

// Silence unused-warning while keeping the import for future tests.
void adminMediaPOST;
