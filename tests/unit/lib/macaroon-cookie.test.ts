import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseMacaroonCookie,
  parseMacaroonExp,
  findMostRecentExpiry,
  getStoredProductIds,
  COOKIE_NAME,
  COOKIE_MAX_AGE,
} from "@/lib/macaroon-cookie";

/**
 * Helper: build a fake Rails MessageVerifier macaroon for tests.
 * Real macaroons are signed with the portal's SECRET_KEY_BASE; here we just
 * encode the payload — `parseMacaroonExp` doesn't verify, only decodes.
 */
function makeMacaroon(payload: {
  productId: string;
  orderId?: string;
  outerExp: Date;
  innerExpUnix?: number;
}): string {
  const body = {
    _rails: {
      data: {
        order_id: payload.orderId ?? "order-test",
        product_id: payload.productId,
        exp: payload.innerExpUnix ?? Math.floor(payload.outerExp.getTime() / 1000),
      },
      exp: payload.outerExp.toISOString(),
      pur: "access_token",
    },
  };
  const b64 = Buffer.from(JSON.stringify(body), "utf-8").toString("base64");
  return `${b64}--fakesig`;
}

describe("macaroon-cookie", () => {
  describe("parseMacaroonCookie", () => {
    it("returns empty object for undefined input", () => {
      expect(parseMacaroonCookie(undefined)).toEqual({});
    });

    it("returns empty object for empty string", () => {
      expect(parseMacaroonCookie("")).toEqual({});
    });

    it("returns empty object for malformed JSON", () => {
      expect(parseMacaroonCookie("{broken")).toEqual({});
    });

    it("parses a valid JSON cookie", () => {
      const raw = JSON.stringify({ "prod-1": "mac-a", "prod-2": "mac-b" });
      expect(parseMacaroonCookie(raw)).toEqual({
        "prod-1": "mac-a",
        "prod-2": "mac-b",
      });
    });

    it("handles a single-entry cookie", () => {
      const raw = JSON.stringify({ "prod-1": "mac-a" });
      expect(parseMacaroonCookie(raw)).toEqual({ "prod-1": "mac-a" });
    });
  });

  describe("getStoredProductIds", () => {
    it("returns empty array when cookie is undefined", () => {
      expect(getStoredProductIds(undefined, ["prod-1", "prod-2"])).toEqual([]);
    });

    it("returns empty array when no candidates match", () => {
      const raw = JSON.stringify({ "prod-x": "mac-x" });
      expect(getStoredProductIds(raw, ["prod-1", "prod-2"])).toEqual([]);
    });

    it("returns matching product IDs", () => {
      const raw = JSON.stringify({ "prod-1": "mac-a", "prod-3": "mac-c" });
      expect(
        getStoredProductIds(raw, ["prod-1", "prod-2", "prod-3"])
      ).toEqual(["prod-1", "prod-3"]);
    });

    it("returns all candidates when all match", () => {
      const raw = JSON.stringify({ "prod-1": "mac-a", "prod-2": "mac-b" });
      expect(getStoredProductIds(raw, ["prod-1", "prod-2"])).toEqual([
        "prod-1",
        "prod-2",
      ]);
    });

    it("returns empty array when candidate list is empty", () => {
      const raw = JSON.stringify({ "prod-1": "mac-a" });
      expect(getStoredProductIds(raw, [])).toEqual([]);
    });

    it("handles malformed cookie gracefully", () => {
      expect(getStoredProductIds("{bad", ["prod-1"])).toEqual([]);
    });

    it("excludes products with empty string macaroon values", () => {
      const raw = JSON.stringify({ "prod-1": "", "prod-2": "mac-b" });
      expect(getStoredProductIds(raw, ["prod-1", "prod-2"])).toEqual(["prod-2"]);
    });

    it("excludes products with null or undefined macaroon values", () => {
      const raw = JSON.stringify({ "prod-1": null, "prod-2": "mac-b" });
      expect(getStoredProductIds(raw, ["prod-1", "prod-2"])).toEqual(["prod-2"]);
    });
  });

  describe("constants", () => {
    it("exports the expected cookie name", () => {
      expect(COOKIE_NAME).toBe("satsrail_macaroons");
    });

    it("exports a 1-year max age", () => {
      expect(COOKIE_MAX_AGE).toBe(365 * 24 * 60 * 60);
    });
  });

  describe("parseMacaroonExp", () => {
    it("decodes the outer Rails exp from a well-formed macaroon", () => {
      const exp = new Date("2026-06-18T00:58:30.237Z");
      const mac = makeMacaroon({ productId: "p1", outerExp: exp });
      expect(parseMacaroonExp(mac)?.toISOString()).toBe(exp.toISOString());
    });

    it("falls back to inner unix exp when outer is missing", () => {
      // Hand-build a payload with no outer exp.
      const body = {
        _rails: {
          data: { order_id: "o", product_id: "p", exp: 1778280839 },
          // no outer exp
          pur: "access_token",
        },
      };
      const mac = `${Buffer.from(JSON.stringify(body)).toString("base64")}--sig`;
      const got = parseMacaroonExp(mac);
      expect(got?.toISOString()).toBe(new Date(1778280839 * 1000).toISOString());
    });

    it("returns null for an empty string", () => {
      expect(parseMacaroonExp("")).toBeNull();
    });

    it("returns null when the payload is not valid base64", () => {
      expect(parseMacaroonExp("!!!not-base64!!!--sig")).toBeNull();
    });

    it("returns null when the decoded payload isn't JSON", () => {
      const garbage = Buffer.from("not json", "utf-8").toString("base64");
      expect(parseMacaroonExp(`${garbage}--sig`)).toBeNull();
    });

    it("returns null when the JSON has no _rails.exp or data.exp", () => {
      const body = { something: "else" };
      const mac = `${Buffer.from(JSON.stringify(body)).toString("base64")}--sig`;
      expect(parseMacaroonExp(mac)).toBeNull();
    });

    it("returns null when the exp string is not a valid date", () => {
      const body = { _rails: { exp: "not-a-date" } };
      const mac = `${Buffer.from(JSON.stringify(body)).toString("base64")}--sig`;
      expect(parseMacaroonExp(mac)).toBeNull();
    });

    it("handles a macaroon with no separator (defensive — older formats)", () => {
      // No `--sig` — should still decode the payload itself.
      const body = { _rails: { exp: "2026-06-18T00:00:00.000Z" } };
      const mac = Buffer.from(JSON.stringify(body)).toString("base64");
      expect(parseMacaroonExp(mac)?.toISOString()).toBe("2026-06-18T00:00:00.000Z");
    });

    it("handles URL-safe base64 (Rails sometimes encodes with `-_` instead of `+/`)", () => {
      // Build a payload whose standard base64 contains `+` or `/`, then
      // swap to URL-safe alphabet, and confirm we still decode it.
      const body = { _rails: { exp: "2026-06-18T00:00:00.000Z" } };
      // Inflate the payload so the base64 reliably contains `+` or `/`.
      const padded = { ...body, padding: "????>>>>////++++????>>>>" };
      const standard = Buffer.from(JSON.stringify(padded)).toString("base64");
      const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_");
      // Sanity: the URL-safe form differs from the standard form for this payload.
      expect(urlSafe).not.toBe(standard);
      expect(parseMacaroonExp(`${urlSafe}--sig`)?.toISOString()).toBe(
        "2026-06-18T00:00:00.000Z"
      );
    });
  });

  describe("findMostRecentExpiry", () => {
    // Pin "now" so tests don't bit-rot.
    const NOW = new Date("2026-05-23T21:00:00.000Z");

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns null when the cookie is undefined", () => {
      expect(findMostRecentExpiry(undefined, ["p1"])).toBeNull();
    });

    it("returns null when no candidate has a matching macaroon", () => {
      const cookie = JSON.stringify({
        other: makeMacaroon({
          productId: "other",
          outerExp: new Date("2026-01-01T00:00:00Z"),
        }),
      });
      expect(findMostRecentExpiry(cookie, ["p1", "p2"])).toBeNull();
    });

    it("returns null when all matching macaroons are still valid", () => {
      const future = new Date("2026-06-18T00:00:00Z");
      const cookie = JSON.stringify({
        p1: makeMacaroon({ productId: "p1", outerExp: future }),
      });
      expect(findMostRecentExpiry(cookie, ["p1"])).toBeNull();
    });

    it("returns the expiry for a single expired matching macaroon", () => {
      const past = new Date("2026-05-08T22:53:59.300Z");
      const cookie = JSON.stringify({
        p1: makeMacaroon({ productId: "p1", outerExp: past }),
      });
      expect(findMostRecentExpiry(cookie, ["p1"])).toEqual({
        productId: "p1",
        expiredAt: past,
      });
    });

    it("returns the MOST RECENT expiry when multiple candidates expired", () => {
      // The founder's actual cookie scenario: 4 expired macaroons, we
      // surface the latest one so the "you paid until X" message reflects
      // the user's most-recent payment.
      const may8 = new Date("2026-05-08T22:53:59.300Z");
      const may15 = new Date("2026-05-15T21:20:45.228Z");
      const cookie = JSON.stringify({
        p1: makeMacaroon({ productId: "p1", outerExp: may8 }),
        p2: makeMacaroon({ productId: "p2", outerExp: may15 }),
      });
      expect(findMostRecentExpiry(cookie, ["p1", "p2"])).toEqual({
        productId: "p2",
        expiredAt: may15,
      });
    });

    it("ignores still-valid macaroons mixed with expired ones", () => {
      const past = new Date("2026-05-15T00:00:00Z");
      const future = new Date("2026-06-18T00:00:00Z");
      const cookie = JSON.stringify({
        p_expired: makeMacaroon({ productId: "p_expired", outerExp: past }),
        p_valid: makeMacaroon({ productId: "p_valid", outerExp: future }),
      });
      expect(findMostRecentExpiry(cookie, ["p_expired", "p_valid"])).toEqual({
        productId: "p_expired",
        expiredAt: past,
      });
    });

    it("only considers candidates passed in (ignores unrelated expired cookie entries)", () => {
      const past = new Date("2026-05-15T00:00:00Z");
      const cookie = JSON.stringify({
        other_product: makeMacaroon({
          productId: "other_product",
          outerExp: past,
        }),
      });
      // Querying for p1 — other_product is in the cookie but not a candidate.
      expect(findMostRecentExpiry(cookie, ["p1"])).toBeNull();
    });

    it("returns null when candidate list is empty", () => {
      const past = new Date("2026-05-15T00:00:00Z");
      const cookie = JSON.stringify({
        p1: makeMacaroon({ productId: "p1", outerExp: past }),
      });
      expect(findMostRecentExpiry(cookie, [])).toBeNull();
    });

    it("ignores malformed macaroon values without throwing", () => {
      const cookie = JSON.stringify({ p1: "totally-bogus--value" });
      expect(findMostRecentExpiry(cookie, ["p1"])).toBeNull();
    });
  });
});
