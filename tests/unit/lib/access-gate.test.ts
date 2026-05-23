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

vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: vi.fn().mockResolvedValue("sk_live_test_key"),
}));

vi.stubGlobal("fetch", mockFetch);

import MediaProduct from "@/models/MediaProduct";
import ChannelProduct from "@/models/ChannelProduct";
import {
  getProductsForMedia,
  verifyMacaroonAccess,
  findExpiredAccessForProducts,
} from "@/lib/access-gate";

/**
 * Build a fake Rails MessageVerifier macaroon for tests.
 * `parseMacaroonExp` doesn't verify the signature, so the format is what
 * matters: base64 of the JSON payload, then `--` then a fake sig.
 */
function makeMacaroon(productId: string, outerExp: Date): string {
  const body = {
    _rails: {
      data: { product_id: productId, exp: Math.floor(outerExp.getTime() / 1000) },
      exp: outerExp.toISOString(),
      pur: "access_token",
    },
  };
  return `${Buffer.from(JSON.stringify(body)).toString("base64")}--fakesig`;
}

describe("access-gate", () => {
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

  // ── getProductsForMedia ──────────────────────────────────────────

  describe("getProductsForMedia", () => {
    it("returns media product when active", async () => {
      const mediaId = new mongoose.Types.ObjectId().toString();
      const channelId = new mongoose.Types.ObjectId().toString();

      await MediaProduct.create({
        media_id: mediaId,
        satsrail_product_id: "prod_media",
        encrypted_source_url: "enc_blob_media",
        key_fingerprint: "fp_media",
        product_status: "active",
      });

      const products = await getProductsForMedia(mediaId, channelId);

      expect(products).toHaveLength(1);
      expect(products[0].productId).toBe("prod_media");
      expect(products[0].encryptedBlob).toBe("enc_blob_media");
      expect(products[0].keyFingerprint).toBe("fp_media");
    });

    it("returns channel product", async () => {
      const mediaId = new mongoose.Types.ObjectId().toString();
      const channelId = new mongoose.Types.ObjectId().toString();

      await ChannelProduct.create({
        channel_id: channelId,
        satsrail_product_id: "prod_channel",
        key_fingerprint: "fp_channel",
        product_status: "active",
        encrypted_media: [
          { media_id: mediaId, encrypted_source_url: "enc_blob_channel" },
        ],
      });

      const products = await getProductsForMedia(mediaId, channelId);

      expect(products).toHaveLength(1);
      expect(products[0].productId).toBe("prod_channel");
      expect(products[0].encryptedBlob).toBe("enc_blob_channel");
    });

    it("returns both media and channel products", async () => {
      const mediaId = new mongoose.Types.ObjectId().toString();
      const channelId = new mongoose.Types.ObjectId().toString();

      await MediaProduct.create({
        media_id: mediaId,
        satsrail_product_id: "prod_m",
        encrypted_source_url: "enc_m",
        product_status: "active",
      });

      await ChannelProduct.create({
        channel_id: channelId,
        satsrail_product_id: "prod_c",
        key_fingerprint: "fp_c",
        product_status: "active",
        encrypted_media: [
          { media_id: mediaId, encrypted_source_url: "enc_c" },
        ],
      });

      const products = await getProductsForMedia(mediaId, channelId);

      expect(products).toHaveLength(2);
      const ids = products.map((p) => p.productId);
      expect(ids).toContain("prod_m");
      expect(ids).toContain("prod_c");
    });

    it("excludes archived media products", async () => {
      const mediaId = new mongoose.Types.ObjectId().toString();
      const channelId = new mongoose.Types.ObjectId().toString();

      await MediaProduct.create({
        media_id: mediaId,
        satsrail_product_id: "prod_archived",
        encrypted_source_url: "enc_archived",
        product_status: "archived",
      });

      const products = await getProductsForMedia(mediaId, channelId);
      expect(products).toHaveLength(0);
    });

    it("excludes archived channel products", async () => {
      const mediaId = new mongoose.Types.ObjectId().toString();
      const channelId = new mongoose.Types.ObjectId().toString();

      await ChannelProduct.create({
        channel_id: channelId,
        satsrail_product_id: "prod_ch_archived",
        key_fingerprint: "fp",
        product_status: "archived",
        encrypted_media: [
          { media_id: mediaId, encrypted_source_url: "enc" },
        ],
      });

      const products = await getProductsForMedia(mediaId, channelId);
      expect(products).toHaveLength(0);
    });

    it("includes products with undefined status (never locks out customers)", async () => {
      const mediaId = new mongoose.Types.ObjectId().toString();
      const channelId = new mongoose.Types.ObjectId().toString();

      await MediaProduct.create({
        media_id: mediaId,
        satsrail_product_id: "prod_no_status",
        encrypted_source_url: "enc_no_status",
        // product_status intentionally omitted
      });

      const products = await getProductsForMedia(mediaId, channelId);

      expect(products).toHaveLength(1);
      expect(products[0].productId).toBe("prod_no_status");
    });

    it("returns empty array when no products exist", async () => {
      const mediaId = new mongoose.Types.ObjectId().toString();
      const channelId = new mongoose.Types.ObjectId().toString();

      const products = await getProductsForMedia(mediaId, channelId);
      expect(products).toHaveLength(0);
    });

    it("returns multiple channel products covering same media", async () => {
      const mediaId = new mongoose.Types.ObjectId().toString();
      const channelId = new mongoose.Types.ObjectId().toString();

      await ChannelProduct.create({
        channel_id: channelId,
        satsrail_product_id: "prod_weekly",
        key_fingerprint: "fp_w",
        product_status: "active",
        encrypted_media: [
          { media_id: mediaId, encrypted_source_url: "enc_weekly" },
        ],
      });

      await ChannelProduct.create({
        channel_id: channelId,
        satsrail_product_id: "prod_monthly",
        key_fingerprint: "fp_m",
        product_status: "active",
        encrypted_media: [
          { media_id: mediaId, encrypted_source_url: "enc_monthly" },
        ],
      });

      const products = await getProductsForMedia(mediaId, channelId);

      expect(products).toHaveLength(2);
      const ids = products.map((p) => p.productId);
      expect(ids).toContain("prod_weekly");
      expect(ids).toContain("prod_monthly");
    });

    it("includes product with inactive status (never locks out customers)", async () => {
      const mediaId = new mongoose.Types.ObjectId().toString();
      const channelId = new mongoose.Types.ObjectId().toString();

      await MediaProduct.create({
        media_id: mediaId,
        satsrail_product_id: "prod_inactive",
        encrypted_source_url: "enc_inactive",
        product_status: "inactive",
      });

      const products = await getProductsForMedia(mediaId, channelId);

      expect(products).toHaveLength(1);
      expect(products[0].productId).toBe("prod_inactive");
    });

    it("includes archived products when includeArchived is true (verification path)", async () => {
      // Existing payments must still grant access even after a merchant
      // archives a product. Verification paths use { includeArchived: true }
      // to find these; purchase UIs keep the default to hide archived buy
      // buttons.
      const mediaId = new mongoose.Types.ObjectId().toString();
      const channelId = new mongoose.Types.ObjectId().toString();

      await MediaProduct.create({
        media_id: mediaId,
        satsrail_product_id: "prod_retired",
        encrypted_source_url: "enc_retired",
        product_status: "archived",
      });

      const purchaseList = await getProductsForMedia(mediaId, channelId);
      expect(purchaseList).toHaveLength(0);

      const verifyList = await getProductsForMedia(mediaId, channelId, {
        includeArchived: true,
      });
      expect(verifyList).toHaveLength(1);
      expect(verifyList[0].productId).toBe("prod_retired");
      expect(verifyList[0].status).toBe("archived");
    });

    it("surfaces product_status on every returned product", async () => {
      // Callers downstream (page render) filter by status to decide what to
      // show vs verify. Confirm the field flows through.
      const mediaId = new mongoose.Types.ObjectId().toString();
      const channelId = new mongoose.Types.ObjectId().toString();

      await MediaProduct.create({
        media_id: mediaId,
        satsrail_product_id: "prod_active",
        encrypted_source_url: "enc_active",
        product_status: "active",
      });

      const [product] = await getProductsForMedia(mediaId, channelId);
      expect(product.status).toBe("active");
    });
  });

  // ── findExpiredAccessForProducts ─────────────────────────────────

  describe("findExpiredAccessForProducts", () => {
    // Pin "now" so expiry comparisons aren't time-sensitive.
    const NOW = new Date("2026-05-23T21:00:00.000Z");
    beforeAll(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });
    afterAll(() => {
      vi.useRealTimers();
    });

    it("returns null when no products are passed", async () => {
      mockCookieStore._set(
        "satsrail_macaroons",
        JSON.stringify({
          p1: makeMacaroon("p1", new Date("2026-05-15T00:00:00Z")),
        })
      );
      expect(await findExpiredAccessForProducts([])).toBeNull();
    });

    it("returns null when no candidates have a matching cookie entry", async () => {
      mockCookieStore._set(
        "satsrail_macaroons",
        JSON.stringify({
          unrelated: makeMacaroon("unrelated", new Date("2026-05-15T00:00:00Z")),
        })
      );
      expect(await findExpiredAccessForProducts(["p_other"])).toBeNull();
    });

    it("returns the most-recent expiry across multiple expired macaroons", async () => {
      // Mirrors the founder's actual scenario: cookie holds 2 expired
      // macaroons for the products covering this media; we surface the
      // newer one so "your access expired on X" is the latest payment.
      const may8 = new Date("2026-05-08T22:53:59.300Z");
      const may15 = new Date("2026-05-15T21:20:45.228Z");
      mockCookieStore._set(
        "satsrail_macaroons",
        JSON.stringify({
          p_older: makeMacaroon("p_older", may8),
          p_newer: makeMacaroon("p_newer", may15),
        })
      );

      const result = await findExpiredAccessForProducts(["p_older", "p_newer"]);
      expect(result).toEqual({ productId: "p_newer", expiredAt: may15 });
    });

    it("ignores still-valid macaroons (we only surface true expiry)", async () => {
      const future = new Date("2026-06-18T00:00:00Z");
      mockCookieStore._set(
        "satsrail_macaroons",
        JSON.stringify({
          p1: makeMacaroon("p1", future),
        })
      );
      expect(await findExpiredAccessForProducts(["p1"])).toBeNull();
    });
  });

  // ── verifyMacaroonAccess ─────────────────────────────────────────

  describe("verifyMacaroonAccess", () => {
    it("returns granted with key when macaroon is valid", async () => {
      mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "mac_valid" }));
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          valid: true,
          key: "decrypt_key",
          key_fingerprint: "fp_verify",
          remaining_seconds: 3600,
        }),
      });

      const result = await verifyMacaroonAccess(["prod_1"]);

      expect(result.granted).toBe(true);
      expect(result.productId).toBe("prod_1");
      expect(result.key).toBe("decrypt_key");
      expect(result.keyFingerprint).toBe("fp_verify");
      expect(result.remainingSeconds).toBe(3600);
    });

    it("tries all products and returns the one with a valid macaroon", async () => {
      mockCookieStore._set("satsrail_macaroons", JSON.stringify({
        prod_2: "mac_for_second",
      }));
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          valid: true,
          key: "key_2",
          remaining_seconds: 1800,
        }),
      });

      const result = await verifyMacaroonAccess(["prod_1", "prod_2", "prod_3"]);

      expect(result.granted).toBe(true);
      expect(result.productId).toBe("prod_2");
      expect(result.key).toBe("key_2");
      // Should only have called fetch once (skipped prod_1 — no macaroon, verified prod_2)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns not granted when no macaroons exist in cookie", async () => {
      // No cookie set
      const result = await verifyMacaroonAccess(["prod_1"]);
      expect(result.granted).toBe(false);
      expect(result.productId).toBeUndefined();
    });

    it("returns not granted when portal definitively rejects the macaroon (402)", async () => {
      mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "mac_invalid" }));
      mockFetch.mockResolvedValue({
        ok: false,
        status: 402,
        json: async () => ({ valid: false, error: { code: "access_expired" } }),
      });

      const result = await verifyMacaroonAccess(["prod_1"]);
      expect(result.granted).toBe(false);
    });

    it("returns not granted on transient portal failure (5xx) without granting access", async () => {
      mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "mac_blip" }));
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      });

      const result = await verifyMacaroonAccess(["prod_1"]);
      expect(result.granted).toBe(false);
    });

    it("returns not granted for empty product list", async () => {
      const result = await verifyMacaroonAccess([]);
      expect(result.granted).toBe(false);
    });

    it("skips products without macaroons and finds valid one", async () => {
      mockCookieStore._set("satsrail_macaroons", JSON.stringify({
        prod_channel: "mac_channel",
      }));
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          valid: true,
          key: "ch_key",
          remaining_seconds: 86400,
        }),
      });

      const result = await verifyMacaroonAccess(["prod_media", "prod_channel"]);

      expect(result.granted).toBe(true);
      expect(result.productId).toBe("prod_channel");
      // Only one fetch (skipped prod_media which had no macaroon)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("continues to next product on network error", async () => {
      mockCookieStore._set("satsrail_macaroons", JSON.stringify({
        prod_1: "mac_1",
        prod_2: "mac_2",
      }));
      mockFetch
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            valid: true,
            key: "key_2",
            remaining_seconds: 3600,
          }),
        });

      const result = await verifyMacaroonAccess(["prod_1", "prod_2"]);

      expect(result.granted).toBe(true);
      expect(result.productId).toBe("prod_2");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("sends correct payload to SatsRail verify endpoint", async () => {
      mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "mac_abc123" }));
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ valid: true, key: "k", remaining_seconds: 100 }),
      });

      await verifyMacaroonAccess(["prod_1"]);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://satsrail.test/api/v1/m/access/verify",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer sk_live_test_key",
          },
          body: JSON.stringify({ access_token: "mac_abc123" }),
        }
      );
    });
  });
});
