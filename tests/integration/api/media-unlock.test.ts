import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct, createChannelProduct } from "../../helpers/factories";

// ── Hoisted mocks ──────────────────────────────────────────────────
const { mockCookieStore, mockFetch } = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return {
    mockCookieStore: {
      get: vi.fn((name: string) => {
        if (store[name]) return { value: store[name] };
        return undefined;
      }),
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
import { GET } from "@/app/api/media/[id]/unlock/route";
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

describe("Media Unlock API — GET /api/media/[id]/unlock", () => {
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

  async function seedWithMediaProduct() {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `unlock-ch-${nextRef()}`,
        name: "Unlock Channel",
        active: true,
      },
    });

    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Locked Video",
        blob: { kind: "url", url: "https://example.com/video.mp4" },
        mediaType: "video",
      },
    });

    await createMediaProduct({
        mediaId: media.id,
        satsrailProductId: "prod_unlock",
        encryptedSourceUrl: "encrypted_blob_123",
        keyFingerprint: "fp_abc",
      });

    return { channelId: channel.id, mediaId: media.id };
  }

  async function seedWithChannelProduct() {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `unlock-ch-cp-${nextRef()}`,
        name: "Channel Product Channel",
        active: true,
      },
    });

    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Channel Locked Video",
        blob: { kind: "url", url: "https://example.com/video2.mp4" },
        mediaType: "video",
      },
    });

    await createChannelProduct({
        channelId: channel.id,
        satsrailProductId: "prod_ch_unlock",
        keyFingerprint: "fp_ch",
        encryptedMedia: [{ mediaId: media.id, encryptedSourceUrl: "ch_encrypted_blob" }],
      });

    return { channelId: channel.id, mediaId: media.id };
  }

  it("returns 404 when media not found", async () => {
    const fakeId = "ckmissingfakefakefakefake";
    const res = await GET(makeRequest(fakeId), makeContext(fakeId));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Media not found");
  });

  it("returns 404 when channel is inactive", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `inactive-ch-${nextRef()}`,
        name: "Inactive Channel",
        active: false,
      },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Inactive Ch Media",
        blob: { kind: "url", url: "https://example.com/inactive.mp4" },
        mediaType: "video",
      },
    });
    const id = media.id;

    const res = await GET(makeRequest(id), makeContext(id));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Channel not found");
  });

  it("returns 404 when no product exists for media", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `no-product-ch-${nextRef()}`,
        name: "No Product Channel",
        active: true,
      },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "No Product Media",
        blob: { kind: "url", url: "https://example.com/noprod.mp4" },
        mediaType: "video",
      },
    });
    const id = media.id;

    const res = await GET(makeRequest(id), makeContext(id));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("No product available for this media");
  });

  it("verifies archived media products too — existing payments must still grant access", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `archived-ch-${nextRef()}`,
        name: "Archived Channel",
        active: true,
      },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Archived Media",
        blob: { kind: "url", url: "https://example.com/archived.mp4" },
        mediaType: "video",
      },
    });
    const mid = media.id;

    await createMediaProduct({
        mediaId: mid,
        satsrailProductId: "prod_archived",
        encryptedSourceUrl: "enc_blob_archived",
        keyFingerprint: "fp_archived",
        productStatus: "archived",
      });

    mockCookieStore._set(
      "satsrail_macaroons",
      JSON.stringify({ prod_archived: "mac_still_valid" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: "decrypt_key_archived",
        remaining_seconds: 3600,
      }),
    });

    const res = await GET(makeRequest(mid), makeContext(mid));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.key).toBe("decrypt_key_archived");
    expect(body.encrypted_blob).toBe("enc_blob_archived");
    expect(body.product_id).toBe("prod_archived");
  });

  it("returns 401 (not 404) for archived product when no macaroon exists", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `archived-ch-no-mac-${nextRef()}`,
        name: "Archived Channel No Mac",
        active: true,
      },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Archived Media No Mac",
        blob: { kind: "url", url: "https://example.com/archived.mp4" },
        mediaType: "video",
      },
    });
    const mid = media.id;

    await createMediaProduct({
        mediaId: mid,
        satsrailProductId: "prod_archived_no_mac",
        encryptedSourceUrl: "enc_blob",
        productStatus: "archived",
      });

    const res = await GET(makeRequest(mid), makeContext(mid));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Payment required");
  });

  it("returns 401 when no macaroon cookie", async () => {
    const { mediaId } = await seedWithMediaProduct();

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Payment required");
  });

  it("returns 401 when macaroon not found for the product", async () => {
    const { mediaId } = await seedWithMediaProduct();
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ other_prod: "mac_other" }));

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Payment required");
  });

  it("returns 401 when SatsRail verify fails", async () => {
    const { mediaId } = await seedWithMediaProduct();
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_unlock: "mac_bad" }));
    mockFetch.mockResolvedValue({ ok: false });

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Payment required");
  });

  it("returns 401 when access is expired (remaining_seconds = 0)", async () => {
    const { mediaId } = await seedWithMediaProduct();
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_unlock: "mac_expired" }));
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ remaining_seconds: 0 }),
    });

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Payment required");
  });

  it("returns key and encrypted_blob for valid media product macaroon", async () => {
    const { mediaId } = await seedWithMediaProduct();
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_unlock: "mac_valid" }));
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: "decrypt_key_123",
        key_fingerprint: "fp_from_verify",
        remaining_seconds: 3600,
      }),
    });

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.key).toBe("decrypt_key_123");
    expect(body.key_fingerprint).toBe("fp_from_verify");
    expect(body.encrypted_blob).toBe("encrypted_blob_123");
  });

  it("falls back to local key_fingerprint when verify response lacks it", async () => {
    const { mediaId } = await seedWithMediaProduct();
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_unlock: "mac_valid" }));
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: "decrypt_key_456",
        remaining_seconds: 1800,
      }),
    });

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.key_fingerprint).toBe("fp_abc");
  });

  it("returns key via channel product when no media product", async () => {
    const { mediaId } = await seedWithChannelProduct();
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_ch_unlock: "mac_ch" }));
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: "ch_key",
        remaining_seconds: 7200,
      }),
    });

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.key).toBe("ch_key");
    expect(body.encrypted_blob).toBe("ch_encrypted_blob");
    expect(body.key_fingerprint).toBe("fp_ch");
  });

  it("verifies archived CHANNEL products too — channel-wide payments survive archive", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `archived-cp-ch-${nextRef()}`,
        name: "Archived CP Channel",
        active: true,
      },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Archived CP Media",
        blob: { kind: "url", url: "https://example.com/archivedcp.mp4" },
        mediaType: "video",
      },
    });
    const mid = media.id;

    await createChannelProduct({
        channelId: channel.id,
        satsrailProductId: "prod_cp_archived",
        keyFingerprint: "fp_cp_arch",
        productStatus: "archived",
        encryptedMedia: [{ mediaId: mid, encryptedSourceUrl: "cp_enc_blob" }],
      });

    mockCookieStore._set(
      "satsrail_macaroons",
      JSON.stringify({ prod_cp_archived: "mac_ch_valid" })
    );
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: "ch_key_after_archive",
        remaining_seconds: 86400,
      }),
    });

    const res = await GET(makeRequest(mid), makeContext(mid));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.key).toBe("ch_key_after_archive");
    expect(body.encrypted_blob).toBe("cp_enc_blob");
  });

  it("returns 401 with expired_at when the cookie holds an expired macaroon for one of this media's products", async () => {
    const { mediaId } = await seedWithMediaProduct();

    const expiredAt = new Date("2026-05-15T21:20:45.228Z");
    const body = {
      _rails: {
        data: {
          product_id: "prod_unlock",
          exp: Math.floor(expiredAt.getTime() / 1000),
        },
        exp: expiredAt.toISOString(),
        pur: "access_token",
      },
    };
    const macaroon = `${Buffer.from(JSON.stringify(body)).toString("base64")}--sig`;

    mockCookieStore._set(
      "satsrail_macaroons",
      JSON.stringify({ prod_unlock: macaroon })
    );
    mockFetch.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ valid: false, error: { code: "access_expired" } }),
    });

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe("Payment required");
    expect(json.expired_at).toBe(expiredAt.toISOString());
    expect(json.expired_product_id).toBe("prod_unlock");
  });

  it("returns 401 WITHOUT expired_at when no matching cookie entry exists at all", async () => {
    const { mediaId } = await seedWithMediaProduct();

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.expired_at).toBeUndefined();
    expect(json.expired_product_id).toBeUndefined();
  });

  // ── Channel + Media product coexistence (the critical bug fix) ────

  async function seedWithBothProducts() {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `both-products-ch-${nextRef()}`,
        name: "Both Products Channel",
        active: true,
      },
    });

    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Dual Product Video",
        blob: { kind: "url", url: "https://example.com/dual.mp4" },
        mediaType: "video",
      },
    });
    const mid = media.id;

    await createMediaProduct({
        mediaId: mid,
        satsrailProductId: "prod_media_individual",
        encryptedSourceUrl: "media_encrypted_blob",
        keyFingerprint: "fp_media",
        productStatus: "active",
      });

    await createChannelProduct({
        channelId: channel.id,
        satsrailProductId: "prod_channel_bundle",
        keyFingerprint: "fp_channel",
        productStatus: "active",
        encryptedMedia: [{ mediaId: mid, encryptedSourceUrl: "channel_encrypted_blob" }],
      });

    return { channelId: channel.id, mediaId: mid };
  }

  it("unlocks via channel product when both products exist but user paid for channel", async () => {
    const { mediaId } = await seedWithBothProducts();
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_channel_bundle: "mac_channel" }));
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: "channel_key_abc",
        remaining_seconds: 86400,
      }),
    });

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.key).toBe("channel_key_abc");
    expect(body.encrypted_blob).toBe("channel_encrypted_blob");
    expect(body.product_id).toBe("prod_channel_bundle");
    expect(body.key_fingerprint).toBe("fp_channel");
  });

  it("prefers media product when user has macaroons for both", async () => {
    const { mediaId } = await seedWithBothProducts();
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({
      prod_media_individual: "mac_media",
      prod_channel_bundle: "mac_channel",
    }));
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: "media_key_xyz",
        remaining_seconds: 3600,
      }),
    });

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.key).toBe("media_key_xyz");
    expect(body.encrypted_blob).toBe("media_encrypted_blob");
    expect(body.product_id).toBe("prod_media_individual");
  });

  it("skips archived media product and unlocks via channel product", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `archived-media-ch-${nextRef()}`,
        name: "Archived Media Channel",
        active: true,
      },
    });

    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Archived Media Video",
        blob: { kind: "url", url: "https://example.com/arch.mp4" },
        mediaType: "video",
      },
    });
    const mid = media.id;

    await createMediaProduct({
        mediaId: mid,
        satsrailProductId: "prod_archived_media",
        encryptedSourceUrl: "archived_blob",
        keyFingerprint: "fp_archived",
        productStatus: "archived",
      });

    await createChannelProduct({
        channelId: channel.id,
        satsrailProductId: "prod_active_channel",
        keyFingerprint: "fp_active_ch",
        productStatus: "active",
        encryptedMedia: [{ mediaId: mid, encryptedSourceUrl: "active_ch_blob" }],
      });

    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_active_channel: "mac_active" }));
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: "active_ch_key",
        remaining_seconds: 7200,
      }),
    });

    const res = await GET(makeRequest(mid), makeContext(mid));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.key).toBe("active_ch_key");
    expect(body.encrypted_blob).toBe("active_ch_blob");
    expect(body.product_id).toBe("prod_active_channel");
  });

  it("returns 401 when both products exist but user has no macaroon for either", async () => {
    const { mediaId } = await seedWithBothProducts();
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ unrelated_product: "mac_other" }));

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Payment required");
  });

  it("tries multiple channel products and unlocks via the one with a macaroon", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `multi-cp-ch-${nextRef()}`,
        name: "Multi CP Channel",
        active: true,
      },
    });

    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Multi CP Video",
        blob: { kind: "url", url: "https://example.com/multi.mp4" },
        mediaType: "video",
      },
    });
    const mid = media.id;

    await createChannelProduct({
        channelId: channel.id,
        satsrailProductId: "prod_cp_weekly",
        keyFingerprint: "fp_weekly",
        productStatus: "active",
        encryptedMedia: [{ mediaId: mid, encryptedSourceUrl: "weekly_blob" }],
      });

    await createChannelProduct({
        channelId: channel.id,
        satsrailProductId: "prod_cp_monthly",
        keyFingerprint: "fp_monthly",
        productStatus: "active",
        encryptedMedia: [{ mediaId: mid, encryptedSourceUrl: "monthly_blob" }],
      });

    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_cp_monthly: "mac_monthly" }));
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: "monthly_key",
        remaining_seconds: 2592000,
      }),
    });

    const res = await GET(makeRequest(mid), makeContext(mid));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.key).toBe("monthly_key");
    expect(body.product_id).toBe("prod_cp_monthly");
    expect(body.encrypted_blob).toBe("monthly_blob");
  });

  it("handles malformed macaroon cookie gracefully", async () => {
    const { mediaId } = await seedWithMediaProduct();
    mockCookieStore._set("satsrail_macaroons", "not-json-at-all");

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Payment required");
  });
});
