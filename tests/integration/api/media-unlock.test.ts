import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";

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
import { GET } from "@/app/api/media/[id]/unlock/route";
import Channel from "@/models/Channel";
import Media from "@/models/Media";
import MediaProduct from "@/models/MediaProduct";
import ChannelProduct from "@/models/ChannelProduct";

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(id: string): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000/api/media/${id}/unlock`));
}

describe("Media Unlock API — GET /api/media/[id]/unlock", () => {
  let channelId: string;
  let mediaId: string;

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
    const channel = await Channel.create({
      ref: 100,
      slug: "unlock-ch",
      name: "Unlock Channel",
      active: true,
    });
    channelId = String(channel._id);

    const media = await Media.create({
      ref: 200,
      channel_id: channelId,
      name: "Locked Video",
      source_url: "https://example.com/video.mp4",
      media_type: "video",
    });
    mediaId = String(media._id);

    await MediaProduct.create({
      media_id: mediaId,
      satsrail_product_id: "prod_unlock",
      encrypted_source_url: "encrypted_blob_123",
      key_fingerprint: "fp_abc",
    });

    return { channelId, mediaId };
  }

  async function seedWithChannelProduct() {
    const channel = await Channel.create({
      ref: 101,
      slug: "unlock-ch-cp",
      name: "Channel Product Channel",
      active: true,
    });
    channelId = String(channel._id);

    const media = await Media.create({
      ref: 201,
      channel_id: channelId,
      name: "Channel Locked Video",
      source_url: "https://example.com/video2.mp4",
      media_type: "video",
    });
    mediaId = String(media._id);

    await ChannelProduct.create({
      channel_id: channelId,
      satsrail_product_id: "prod_ch_unlock",
      key_fingerprint: "fp_ch",
      encrypted_media: [
        { media_id: mediaId, encrypted_source_url: "ch_encrypted_blob" },
      ],
    });

    return { channelId, mediaId };
  }

  it("returns 404 when media not found", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await GET(makeRequest(fakeId), makeContext(fakeId));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Media not found");
  });

  it("returns 404 when channel not found", async () => {
    const fakeChannelId = new mongoose.Types.ObjectId().toString();
    const media = await Media.create({
      ref: 300,
      channel_id: fakeChannelId,
      name: "Orphan Media",
      source_url: "https://example.com/orphan.mp4",
      media_type: "video",
    });
    const id = String(media._id);

    const res = await GET(makeRequest(id), makeContext(id));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Channel not found");
  });

  it("returns 404 when channel is inactive", async () => {
    const channel = await Channel.create({
      ref: 102,
      slug: "inactive-ch",
      name: "Inactive Channel",
      active: false,
    });
    const media = await Media.create({
      ref: 301,
      channel_id: String(channel._id),
      name: "Inactive Ch Media",
      source_url: "https://example.com/inactive.mp4",
      media_type: "video",
    });
    const id = String(media._id);

    const res = await GET(makeRequest(id), makeContext(id));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Channel not found");
  });

  it("returns 404 when no product exists for media", async () => {
    const channel = await Channel.create({
      ref: 103,
      slug: "no-product-ch",
      name: "No Product Channel",
      active: true,
    });
    const media = await Media.create({
      ref: 302,
      channel_id: String(channel._id),
      name: "No Product Media",
      source_url: "https://example.com/noprod.mp4",
      media_type: "video",
    });
    const id = String(media._id);

    const res = await GET(makeRequest(id), makeContext(id));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("No product available for this media");
  });

  it("verifies archived media products too — existing payments must still grant access", async () => {
    // Architectural change: archiving a product means "stop selling new
    // access", not "revoke existing access". A customer who paid before
    // the archive must still be able to view the content. The unlock
    // route uses `includeArchived: true` so the archived product enters
    // the verification list; verifyMacaroonAccess does the rest.
    const channel = await Channel.create({
      ref: 104,
      slug: "archived-ch",
      name: "Archived Channel",
      active: true,
    });
    const media = await Media.create({
      ref: 303,
      channel_id: String(channel._id),
      name: "Archived Media",
      source_url: "https://example.com/archived.mp4",
      media_type: "video",
    });
    const mid = String(media._id);

    await MediaProduct.create({
      media_id: mid,
      satsrail_product_id: "prod_archived",
      encrypted_source_url: "enc_blob_archived",
      key_fingerprint: "fp_archived",
      product_status: "archived",
    });

    // With a valid macaroon: the archived product unlocks normally.
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
    // Same setup as above, but no macaroon — should now be 401 "payment
    // required", not 404 "no product available". The product DOES exist;
    // the user just doesn't have proof of payment.
    const channel = await Channel.create({
      ref: 1041,
      slug: "archived-ch-no-mac",
      name: "Archived Channel No Mac",
      active: true,
    });
    const media = await Media.create({
      ref: 3031,
      channel_id: String(channel._id),
      name: "Archived Media No Mac",
      source_url: "https://example.com/archived.mp4",
      media_type: "video",
    });
    const mid = String(media._id);

    await MediaProduct.create({
      media_id: mid,
      satsrail_product_id: "prod_archived_no_mac",
      encrypted_source_url: "enc_blob",
      product_status: "archived",
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
    // Same archive-survives-payment invariant for channel-level products.
    const channel = await Channel.create({
      ref: 105,
      slug: "archived-cp-ch",
      name: "Archived CP Channel",
      active: true,
    });
    const media = await Media.create({
      ref: 304,
      channel_id: String(channel._id),
      name: "Archived CP Media",
      source_url: "https://example.com/archivedcp.mp4",
      media_type: "video",
    });
    const mid = String(media._id);

    await ChannelProduct.create({
      channel_id: String(channel._id),
      satsrail_product_id: "prod_cp_archived",
      key_fingerprint: "fp_cp_arch",
      product_status: "archived",
      encrypted_media: [
        { media_id: mid, encrypted_source_url: "cp_enc_blob" },
      ],
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
    // The diagnostic surface: when verifyMacaroonAccess returns no live
    // access, the route peeks into the cookie and reports the most-recent
    // expiry. The client then renders "your access expired on X, pay to
    // renew" instead of a silent paywall.
    const { mediaId } = await seedWithMediaProduct();

    // A real expired macaroon (Rails MessageVerifier format). The portal
    // verify will reject (mocked below), but findExpiredAccessForProducts
    // reads the encoded exp locally.
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
    // Fresh visitor — never paid for anything that covers this media.
    // Nothing in the cookie to surface; the paywall renders normally.
    const { mediaId } = await seedWithMediaProduct();

    const res = await GET(makeRequest(mediaId), makeContext(mediaId));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.expired_at).toBeUndefined();
    expect(json.expired_product_id).toBeUndefined();
  });

  // ── Channel + Media product coexistence (the critical bug fix) ────

  async function seedWithBothProducts() {
    const channel = await Channel.create({
      ref: 110,
      slug: "both-products-ch",
      name: "Both Products Channel",
      active: true,
    });
    const cid = String(channel._id);

    const media = await Media.create({
      ref: 210,
      channel_id: cid,
      name: "Dual Product Video",
      source_url: "https://example.com/dual.mp4",
      media_type: "video",
    });
    const mid = String(media._id);

    await MediaProduct.create({
      media_id: mid,
      satsrail_product_id: "prod_media_individual",
      encrypted_source_url: "media_encrypted_blob",
      key_fingerprint: "fp_media",
      product_status: "active",
    });

    await ChannelProduct.create({
      channel_id: cid,
      satsrail_product_id: "prod_channel_bundle",
      key_fingerprint: "fp_channel",
      product_status: "active",
      encrypted_media: [
        { media_id: mid, encrypted_source_url: "channel_encrypted_blob" },
      ],
    });

    channelId = cid;
    mediaId = mid;
    return { channelId: cid, mediaId: mid };
  }

  it("unlocks via channel product when both products exist but user paid for channel", async () => {
    const { mediaId } = await seedWithBothProducts();
    // User only has a macaroon for the channel product, NOT the media product
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
    const channel = await Channel.create({
      ref: 111,
      slug: "archived-media-ch",
      name: "Archived Media Channel",
      active: true,
    });
    const cid = String(channel._id);

    const media = await Media.create({
      ref: 211,
      channel_id: cid,
      name: "Archived Media Video",
      source_url: "https://example.com/arch.mp4",
      media_type: "video",
    });
    const mid = String(media._id);

    await MediaProduct.create({
      media_id: mid,
      satsrail_product_id: "prod_archived_media",
      encrypted_source_url: "archived_blob",
      key_fingerprint: "fp_archived",
      product_status: "archived",
    });

    await ChannelProduct.create({
      channel_id: cid,
      satsrail_product_id: "prod_active_channel",
      key_fingerprint: "fp_active_ch",
      product_status: "active",
      encrypted_media: [
        { media_id: mid, encrypted_source_url: "active_ch_blob" },
      ],
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
    const channel = await Channel.create({
      ref: 112,
      slug: "multi-cp-ch",
      name: "Multi CP Channel",
      active: true,
    });
    const cid = String(channel._id);

    const media = await Media.create({
      ref: 212,
      channel_id: cid,
      name: "Multi CP Video",
      source_url: "https://example.com/multi.mp4",
      media_type: "video",
    });
    const mid = String(media._id);

    // Two channel products covering the same media
    await ChannelProduct.create({
      channel_id: cid,
      satsrail_product_id: "prod_cp_weekly",
      key_fingerprint: "fp_weekly",
      product_status: "active",
      encrypted_media: [
        { media_id: mid, encrypted_source_url: "weekly_blob" },
      ],
    });

    await ChannelProduct.create({
      channel_id: cid,
      satsrail_product_id: "prod_cp_monthly",
      key_fingerprint: "fp_monthly",
      product_status: "active",
      encrypted_media: [
        { media_id: mid, encrypted_source_url: "monthly_blob" },
      ],
    });

    // User paid for the monthly plan only
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

  it("returns 500 on unexpected errors", async () => {
    // Use invalid ObjectId to trigger a cast error
    const badId = "not-a-valid-id";
    const res = await GET(makeRequest(badId), makeContext(badId));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to fetch content key");
  });
});
