import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { randomBytes } from "crypto";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";
import { encryptSourceUrl, encryptBytes } from "@/lib/content-encryption";
import {
  base64urlToBytes,
  bytesToBase64url,
  clientDecryptBlob,
  clientDecryptBytesWithKey,
  genProductKey,
  sha256HexOfString,
} from "../../helpers/crypto";

// ── Hoisted mocks ─────────────────────────────────────────────────────
//
// The unlock route reads the macaroon cookie, calls the SatsRail portal
// to verify it, and returns the (already-encrypted) MediaProduct payload.
// We mock the portal verify call so the test stays hermetic, and we mock
// the cookie store so the route believes the customer has paid.

const { mockCookieStore, mockFetch } = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return {
    mockCookieStore: {
      get: vi.fn((name: string) => (store[name] ? { value: store[name] } : undefined)),
      _set: (name: string, value: string) => { store[name] = value; },
      _clear: () => { for (const k in store) delete store[k]; },
    },
    mockFetch: vi.fn(),
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue(mockCookieStore),
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/mongodb", () => ({
  connectDB: vi.fn().mockImplementation(async () => mongoose),
}));

vi.mock("@/config/instance", () => ({
  getInstanceConfig: vi.fn().mockResolvedValue({
    satsrail: { apiUrl: "https://satsrail.test/api/v1" },
  }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: vi.fn().mockResolvedValue("sk_live_test_key"),
}));

vi.stubGlobal("fetch", mockFetch);

import { NextRequest } from "next/server";
import { GET as unlockGET } from "@/app/api/media/[id]/unlock/route";
import Channel from "@/models/Channel";
import Media from "@/models/Media";
import MediaProduct from "@/models/MediaProduct";

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}
function makeRequest(id: string): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000/api/media/${id}/unlock`));
}

/**
 * End-to-end behavior specs for the post-payment unlock path.
 *
 * Each test stitches together the THREE moving pieces that have to agree:
 *   1. Server-side encryption at create-product time   (Node `crypto`)
 *   2. The unlock HTTP endpoint                        (route handler)
 *   3. Client-side decryption in PaymentWall           (Web Crypto)
 *
 * If any of the three drifts in IV layout, AAD encoding, base64url
 * normalization, or envelope shape, the round-trip breaks — which is
 * exactly the "Payment received, couldn't unlock" customer report.
 *
 * Using REAL encryption + REAL HTTP route + REAL Web Crypto on the
 * other side means a regression in any one corner is caught here.
 */
describe("Unlock endpoint → client decryption end-to-end", () => {
  beforeAll(async () => {
    await setupTestDB();
  });
  afterAll(async () => {
    await teardownTestDB();
  });
  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    mockCookieStore._clear();
  });

  async function seedMediaProduct(opts: {
    mediaType: "article" | "photo" | "video";
    sourceUrl: string;
    encryptedSourceUrl: string;
    keyFingerprintHex: string;
    productId: string;
  }) {
    const channel = await Channel.create({
      ref: 1,
      slug: "showcase",
      name: "Platform Showcase",
      active: true,
    });
    const media = await Media.create({
      ref: 1,
      channel_id: channel._id,
      name: "Test media",
      source_url: opts.sourceUrl,
      media_type: opts.mediaType,
    });
    await MediaProduct.create({
      media_id: media._id,
      satsrail_product_id: opts.productId,
      encrypted_source_url: opts.encryptedSourceUrl,
      key_fingerprint: opts.keyFingerprintHex,
    });
    return { mediaId: String(media._id), channelId: String(channel._id) };
  }

  it("article: full lifecycle — create-product encrypt → unlock endpoint → Web Crypto decrypt recovers the markdown", async () => {
    const productKey = genProductKey();
    const productId = "550e8400-e29b-41d4-a716-446655440000";
    const articleBody = [
      "# Article",
      "",
      "Body with **markdown** and unicode: café, 中文, 🔥.",
      "",
      "[A link](https://example.com)",
    ].join("\n");

    // Step 1 — server-side encryption as `/api/admin/media/[id]/create-product` does
    const encryptedSourceUrl = encryptSourceUrl(articleBody, productKey, productId);
    const fingerprintHex = await sha256HexOfString(productKey);

    const { mediaId } = await seedMediaProduct({
      mediaType: "article",
      sourceUrl: articleBody, // never exposed to client; stored for completeness
      encryptedSourceUrl,
      keyFingerprintHex: fingerprintHex,
      productId,
    });

    // Step 2 — the customer has paid; cookie + portal verify happy path
    mockCookieStore._set(
      "satsrail_macaroons",
      JSON.stringify({ [productId]: "mac_valid" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: productKey,
        key_fingerprint: fingerprintHex,
        remaining_seconds: 3600,
      }),
    });

    const res = await unlockGET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.product_id).toBe(productId);
    expect(body.key).toBe(productKey);
    expect(body.encrypted_blob).toBe(encryptedSourceUrl);
    // Drives the access pill in MediaHeader. The portal already returned
    // this via verifyMacaroonAccess; the unlock route must propagate it so
    // useMediaAccess can populate `remainingSeconds` on a returning visitor.
    // Regression guard: without this, MediaHeader sees remainingSeconds=0,
    // treats access as inactive for UI purposes, and the price pill stays
    // visible even though content decrypts.
    expect(body.remaining_seconds).toBe(3600);

    // Step 3 — client decryption (Web Crypto), the exact path PaymentWall runs
    const recovered = await clientDecryptBlob(body.encrypted_blob, body.key, body.product_id);
    expect(new TextDecoder().decode(recovered)).toBe(articleBody);
  });

  it("photo: full envelope lifecycle — wrap DEK → unlock endpoint → unwrap → recover image bytes", async () => {
    const productKey = genProductKey();
    const productId = "550e8400-e29b-41d4-a716-446655440001";

    // Step 1 — server-side: encrypt photo under a per-photo DEK, wrap DEK under product key
    const dek = randomBytes(32);
    const photoBytes = Buffer.from(
      Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        ...Buffer.from("FAKE-PNG-PAYLOAD-BYTES"),
      ])
    );
    const gridFsCiphertext = encryptBytes(photoBytes, dek);

    const dekBase64url = bytesToBase64url(dek);
    const wrappedDek = encryptSourceUrl(dekBase64url, productKey, productId);
    const fingerprintHex = await sha256HexOfString(productKey);

    const { mediaId } = await seedMediaProduct({
      mediaType: "photo",
      sourceUrl: "gridfs-id-placeholder", // in prod this is the GridFS ObjectId string
      encryptedSourceUrl: wrappedDek,
      keyFingerprintHex: fingerprintHex,
      productId,
    });

    // Step 2 — paid customer; portal verify happy path
    mockCookieStore._set(
      "satsrail_macaroons",
      JSON.stringify({ [productId]: "mac_valid" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: productKey,
        key_fingerprint: fingerprintHex,
        remaining_seconds: 86400,
      }),
    });

    const res = await unlockGET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.encrypted_blob).toBe(wrappedDek);

    // Step 3a — client unwraps the DEK envelope
    const innerBytes = await clientDecryptBlob(body.encrypted_blob, body.key, body.product_id);
    const recoveredDekStr = new TextDecoder().decode(innerBytes);
    expect(recoveredDekStr).toBe(dekBase64url);
    const recoveredDek = base64urlToBytes(recoveredDekStr);
    expect(Buffer.compare(Buffer.from(recoveredDek), dek)).toBe(0);

    // Step 3b — client decrypts the GridFS bytes with the recovered DEK
    const recoveredPhoto = await clientDecryptBytesWithKey(
      new Uint8Array(gridFsCiphertext),
      recoveredDek
    );
    expect(Buffer.compare(Buffer.from(recoveredPhoto), photoBytes)).toBe(0);
  });

  it("article: rotation — re-encrypt under a NEW product key still decrypts correctly", async () => {
    // Simulates the re-encrypt admin flow: same source_url, fresh product key.
    // After rotation, the cookie store + portal must hand the client the NEW key
    // matched to the NEW fingerprint.
    const productId = "550e8400-e29b-41d4-a716-446655440002";
    const articleBody = "Article body for rotation test.";

    const oldKey = genProductKey();
    const newKey = genProductKey();
    expect(oldKey).not.toBe(newKey);

    // Stored value is the re-encrypted blob under the NEW key
    const reEncryptedBlob = encryptSourceUrl(articleBody, newKey, productId);
    const newFp = await sha256HexOfString(newKey);

    const { mediaId } = await seedMediaProduct({
      mediaType: "article",
      sourceUrl: articleBody,
      encryptedSourceUrl: reEncryptedBlob,
      keyFingerprintHex: newFp,
      productId,
    });

    mockCookieStore._set(
      "satsrail_macaroons",
      JSON.stringify({ [productId]: "mac_valid" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: newKey,
        key_fingerprint: newFp,
        remaining_seconds: 3600,
      }),
    });

    const res = await unlockGET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();
    expect(res.status).toBe(200);

    const recovered = await clientDecryptBlob(body.encrypted_blob, body.key, body.product_id);
    expect(new TextDecoder().decode(recovered)).toBe(articleBody);

    // Cross-check: old key must NOT decrypt the new blob — confirms rotation
    // really did change the key the blob was encrypted under.
    await expect(clientDecryptBlob(body.encrypted_blob, oldKey, body.product_id)).rejects.toBeTruthy();
  });
});
