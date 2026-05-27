import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { randomBytes } from "crypto";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct } from "../../helpers/factories";
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
import { prisma } from "@/lib/prisma";

let refSeed = 5000;
function nextRef(): number {
  refSeed += 1;
  return refSeed;
}

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}
function makeRequest(id: string): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000/api/media/${id}/unlock`));
}

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
    encryptedSource: string;
    keyFingerprintHex: string;
    productId: string;
  }) {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `showcase-${nextRef()}`,
        name: "Platform Showcase",
        active: true,
      },
    });
    const blob =
      opts.mediaType === "article"
        ? {
            kind: "article",
            envelopeId: opts.sourceUrl,
            encryptedDek: "test_dek",
            mimeType: "text/markdown; charset=utf-8",
          }
        : opts.mediaType === "photo"
          ? {
              kind: "photo",
              envelopeId: opts.sourceUrl,
              encryptedDek: "test_dek",
              mimeType: "image/jpeg",
            }
          : { kind: "url", url: opts.sourceUrl };
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Test media",
        blob,
        mediaType: opts.mediaType,
      },
    });
    await createMediaProduct({
        mediaId: media.id,
        satsrailProductId: opts.productId,
        encryptedSource: opts.encryptedSource,
        keyFingerprint: opts.keyFingerprintHex,
      });
    return { mediaId: media.id, channelId: channel.id };
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

    const encryptedSource = encryptSourceUrl(articleBody, productKey, productId);
    const fingerprintHex = await sha256HexOfString(productKey);

    const { mediaId } = await seedMediaProduct({
      mediaType: "article",
      sourceUrl: articleBody,
      encryptedSource,
      keyFingerprintHex: fingerprintHex,
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
    expect(body.encrypted_blob).toBe(encryptedSource);
    expect(body.remaining_seconds).toBe(3600);

    const recovered = await clientDecryptBlob(body.encrypted_blob, body.key, body.product_id);
    expect(new TextDecoder().decode(recovered)).toBe(articleBody);
  });

  it("photo: full envelope lifecycle — wrap DEK → unlock endpoint → unwrap → recover image bytes", async () => {
    const productKey = genProductKey();
    const productId = "550e8400-e29b-41d4-a716-446655440001";

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
      sourceUrl: "blob-id-placeholder",
      encryptedSource: wrappedDek,
      keyFingerprintHex: fingerprintHex,
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
        key: productKey,
        key_fingerprint: fingerprintHex,
        remaining_seconds: 86400,
      }),
    });

    const res = await unlockGET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.encrypted_blob).toBe(wrappedDek);

    const innerBytes = await clientDecryptBlob(body.encrypted_blob, body.key, body.product_id);
    const recoveredDekStr = new TextDecoder().decode(innerBytes);
    expect(recoveredDekStr).toBe(dekBase64url);
    const recoveredDek = base64urlToBytes(recoveredDekStr);
    expect(Buffer.compare(Buffer.from(recoveredDek), dek)).toBe(0);

    const recoveredPhoto = await clientDecryptBytesWithKey(
      new Uint8Array(gridFsCiphertext),
      recoveredDek
    );
    expect(Buffer.compare(Buffer.from(recoveredPhoto), photoBytes)).toBe(0);
  });

  it("article: rotation — re-encrypt under a NEW product key still decrypts correctly", async () => {
    const productId = "550e8400-e29b-41d4-a716-446655440002";
    const articleBody = "Article body for rotation test.";

    const oldKey = genProductKey();
    const newKey = genProductKey();
    expect(oldKey).not.toBe(newKey);

    const reEncryptedBlob = encryptSourceUrl(articleBody, newKey, productId);
    const newFp = await sha256HexOfString(newKey);

    const { mediaId } = await seedMediaProduct({
      mediaType: "article",
      sourceUrl: articleBody,
      encryptedSource: reEncryptedBlob,
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

    await expect(clientDecryptBlob(body.encrypted_blob, oldKey, body.product_id)).rejects.toBeTruthy();
  });
});
