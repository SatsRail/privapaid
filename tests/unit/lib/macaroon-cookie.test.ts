import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseMacaroonCookie,
  parseMacaroonExp,
  findMostRecentExpiry,
  isMacaroonExpired,
  pruneExpiredMacaroons,
  getStoredProductIds,
  getMacaroon,
  serializeMacaroonCookie,
  insertWithCap,
  COOKIE_NAME,
  COOKIE_MAX_AGE,
  MAX_BYTES,
  MAX_ENTRIES,
  EXPIRY_GRACE_MS,
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

    it("upgrades a legacy string-valued cookie to the {m, t} shape", () => {
      const raw = JSON.stringify({ "prod-1": "mac-a", "prod-2": "mac-b" });
      expect(parseMacaroonCookie(raw)).toEqual({
        "prod-1": { m: "mac-a", t: 0 },
        "prod-2": { m: "mac-b", t: 0 },
      });
    });

    it("parses a current-shape cookie verbatim", () => {
      const raw = JSON.stringify({
        "prod-1": { m: "mac-a", t: 1700000000000 },
      });
      expect(parseMacaroonCookie(raw)).toEqual({
        "prod-1": { m: "mac-a", t: 1700000000000 },
      });
    });

    it("returns empty object when the JSON has shape violations", () => {
      // Zod rejects non-string / non-object entries — the whole cookie
      // is treated as malformed rather than half-trusted.
      const raw = JSON.stringify({ "prod-1": 42 });
      expect(parseMacaroonCookie(raw)).toEqual({});
    });

    it("mixes legacy and current shapes in the same cookie", () => {
      const raw = JSON.stringify({
        legacy: "mac-legacy",
        current: { m: "mac-current", t: 12345 },
      });
      expect(parseMacaroonCookie(raw)).toEqual({
        legacy: { m: "mac-legacy", t: 0 },
        current: { m: "mac-current", t: 12345 },
      });
    });
  });

  describe("getMacaroon", () => {
    it("returns the macaroon string for a stored product", () => {
      const raw = JSON.stringify({ p1: { m: "mac-1", t: 1 } });
      expect(getMacaroon(raw, "p1")).toBe("mac-1");
    });

    it("returns undefined when not stored", () => {
      expect(getMacaroon(JSON.stringify({}), "p1")).toBeUndefined();
    });

    it("handles legacy string entries", () => {
      const raw = JSON.stringify({ p1: "legacy-mac" });
      expect(getMacaroon(raw, "p1")).toBe("legacy-mac");
    });
  });

  describe("MAX_BYTES budget", () => {
    it("stays well under Chrome's 4096-byte per-cookie hard limit (RFC 6265)", () => {
      // Chrome silently drops Set-Cookie when the value exceeds ~4096
      // bytes. Our cookie value is URL-encoded in the Set-Cookie header,
      // which adds ~25% for `{`, `}`, `"`, `:`, `,`. So a 3000-byte raw
      // JSON becomes ~3750 encoded — already perilously close to 4096.
      // 2500 raw → ~3125 encoded, leaving ~970 bytes of cushion for
      // attributes (Max-Age, Path, SameSite, HttpOnly, Secure) and any
      // future per-macaroon size growth. This guard prevents anyone from
      // bumping MAX_BYTES to a value that re-introduces the Chrome bug
      // the founder hit (paid in Chrome → cookie dropped → next page load
      // had no proof of payment).
      const CHROME_COOKIE_HARD_LIMIT = 4096;
      const URL_ENCODE_OVERHEAD = 1.30;
      const COOKIE_ATTRIBUTES_OVERHEAD = 100;
      const projectedTransmittedSize =
        MAX_BYTES * URL_ENCODE_OVERHEAD + COOKIE_ATTRIBUTES_OVERHEAD;
      expect(projectedTransmittedSize).toBeLessThan(CHROME_COOKIE_HARD_LIMIT);
    });
  });

  describe("insertWithCap", () => {
    it("inserts a new entry without eviction when under cap", () => {
      const { map, evicted } = insertWithCap({}, "p1", "mac", 100);
      expect(map).toEqual({ p1: { m: "mac", t: 100 } });
      expect(evicted).toBe(0);
    });

    it("overwrites an existing entry without eviction", () => {
      const initial = { p1: { m: "old", t: 50 } };
      const { map, evicted } = insertWithCap(initial, "p1", "new", 100);
      expect(map.p1).toEqual({ m: "new", t: 100 });
      expect(evicted).toBe(0);
    });

    it("evicts oldest entries when MAX_ENTRIES would be exceeded", () => {
      const map: Record<string, { m: string; t: number }> = {};
      for (let i = 0; i < MAX_ENTRIES; i++) {
        map[`p${i}`] = { m: "x", t: i };
      }
      const result = insertWithCap(map, "new", "y", MAX_ENTRIES + 1);
      // Should have evicted p0 (oldest) to make room.
      expect(result.evicted).toBeGreaterThanOrEqual(1);
      expect(result.map.p0).toBeUndefined();
      expect(result.map.new).toEqual({ m: "y", t: MAX_ENTRIES + 1 });
      expect(Object.keys(result.map).length).toBeLessThanOrEqual(MAX_ENTRIES);
    });

    it("evicts when serialized size would exceed MAX_BYTES", () => {
      const big = "x".repeat(100);
      const map: Record<string, { m: string; t: number }> = {};
      let i = 0;
      while (serializeMacaroonCookie(map).length < MAX_BYTES - 200) {
        map[`p${i}`] = { m: big, t: i };
        i++;
      }
      const startSize = Object.keys(map).length;
      const result = insertWithCap(map, "newer", big, i + 1);
      expect(serializeMacaroonCookie(result.map).length).toBeLessThanOrEqual(MAX_BYTES);
      expect(result.map.newer).toEqual({ m: big, t: i + 1 });
      // Older entries are gone.
      expect(Object.keys(result.map).length).toBeLessThan(startSize + 1);
      expect(result.evicted).toBeGreaterThan(0);
    });

    it("throws MACAROON_TOO_LARGE when a single entry exceeds the cap", () => {
      const huge = "y".repeat(MAX_BYTES + 100);
      expect(() => insertWithCap({}, "p1", huge, 1)).toThrow(
        "MACAROON_TOO_LARGE"
      );
    });

    it("evicts DEAD (expired) macaroons before still-valid ones under cap pressure", () => {
      // Heavy-buyer protection: a full cookie holds one still-valid macaroon
      // (the OLDEST by storage time — the original oldest-first eviction would
      // have killed it first) plus several expired ones. Inserting a fresh
      // purchase must shed the dead tokens and spare the live one.
      const NOW = new Date("2026-05-23T21:00:00.000Z");
      const PAST = new Date("2026-05-20T00:00:00.000Z"); // expired
      const FUTURE = new Date("2026-12-01T00:00:00.000Z"); // valid
      // Inflate each macaroon so a handful exceed MAX_BYTES (and so the
      // valid + new pair comfortably fits, guaranteeing the valid one can
      // survive once the dead ones are gone).
      const pad = "x".repeat(500);

      const map: Record<string, { m: string; t: number }> = {
        valid_oldest: {
          m: makeMacaroon({ productId: `valid_${pad}`, outerExp: FUTURE }),
          t: 0,
        },
      };
      const DEAD_COUNT = 4;
      for (let i = 0; i < DEAD_COUNT; i++) {
        map[`dead_${i}`] = {
          m: makeMacaroon({ productId: `dead_${i}_${pad}`, outerExp: PAST }),
          t: i + 1,
        };
      }
      // Precondition: already over the byte budget, so eviction must run.
      expect(serializeMacaroonCookie(map).length).toBeGreaterThan(MAX_BYTES);

      const { map: out, evicted } = insertWithCap(
        map,
        "new_prod",
        makeMacaroon({ productId: `new_${pad}`, outerExp: FUTURE }),
        NOW.getTime()
      );

      // The just-paid macaroon always survives.
      expect(out.new_prod).toBeDefined();
      // The still-valid macaroon survives despite being the oldest-stored —
      // the dead ones were sacrificed first.
      expect(out.valid_oldest).toBeDefined();
      // Eviction happened and fell on the dead entries.
      expect(evicted).toBeGreaterThan(0);
      const deadRemaining = Object.keys(out).filter((k) =>
        k.startsWith("dead_")
      ).length;
      expect(deadRemaining).toBeLessThan(DEAD_COUNT);
      // Result fits the cookie budget.
      expect(serializeMacaroonCookie(out).length).toBeLessThanOrEqual(MAX_BYTES);
    });

    it("falls back to oldest-stored eviction when no entry is expired", () => {
      // With no parseable/expired exp, behavior is unchanged from the original
      // oldest-first policy — opaque tokens are never assumed dead.
      const big = "x".repeat(300);
      const map: Record<string, { m: string; t: number }> = {};
      let i = 0;
      while (serializeMacaroonCookie(map).length < MAX_BYTES - 200) {
        map[`p${i}`] = { m: big, t: i };
        i++;
      }
      const { map: out } = insertWithCap(map, "newer", big, i + 1);
      // Oldest (p0) goes first; the just-inserted entry stays.
      expect(out.p0).toBeUndefined();
      expect(out.newer).toEqual({ m: big, t: i + 1 });
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

    it("returns empty when null appears (whole cookie fails schema)", () => {
      // null is no longer an allowed entry value — schema rejection drops
      // the entire cookie. Better than silently keeping bad shapes.
      const raw = JSON.stringify({ "prod-1": null, "prod-2": "mac-b" });
      expect(getStoredProductIds(raw, ["prod-1", "prod-2"])).toEqual([]);
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

  describe("isMacaroonExpired", () => {
    const NOW = new Date("2026-05-23T21:00:00.000Z");

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns true when the macaroon's signed exp is in the past", () => {
      const mac = makeMacaroon({
        productId: "p1",
        outerExp: new Date("2026-05-22T00:00:00Z"),
      });
      expect(isMacaroonExpired(mac)).toBe(true);
    });

    it("returns false when the exp is in the future", () => {
      const mac = makeMacaroon({
        productId: "p1",
        outerExp: new Date("2026-06-01T00:00:00Z"),
      });
      expect(isMacaroonExpired(mac)).toBe(false);
    });

    it("treats the exact expiry instant as expired (<=)", () => {
      const mac = makeMacaroon({ productId: "p1", outerExp: NOW });
      expect(isMacaroonExpired(mac)).toBe(true);
    });

    it("returns false (unknown freshness) when the exp can't be parsed", () => {
      // An opaque/legacy macaroon must NOT be assumed dead — the portal is
      // the judge. Both a bogus token and an empty string read as unknown.
      expect(isMacaroonExpired("totally-bogus--value")).toBe(false);
      expect(isMacaroonExpired("")).toBe(false);
    });

    it("honors an explicit `now` argument over the system clock", () => {
      const mac = makeMacaroon({
        productId: "p1",
        outerExp: new Date("2026-05-22T00:00:00Z"),
      });
      // `now` before exp → still valid.
      expect(
        isMacaroonExpired(mac, new Date("2026-05-21T00:00:00Z").getTime())
      ).toBe(false);
      // `now` after exp → expired.
      expect(
        isMacaroonExpired(mac, new Date("2026-05-23T00:00:00Z").getTime())
      ).toBe(true);
    });
  });

  describe("pruneExpiredMacaroons", () => {
    const NOW = new Date("2026-05-23T21:00:00.000Z");

    function entry(productId: string, outerExp: Date, t = 1) {
      return { m: makeMacaroon({ productId, outerExp }), t };
    }

    it("exports a 7-day grace window", () => {
      expect(EXPIRY_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("drops entries expired beyond the grace window", () => {
      // ~13 days before NOW → well past the 7-day grace → pruned.
      const map = { old: entry("old", new Date("2026-05-10T00:00:00Z")) };
      const { map: out, pruned } = pruneExpiredMacaroons(map, NOW.getTime());
      expect(pruned).toBe(1);
      expect(out.old).toBeUndefined();
    });

    it("keeps entries expired WITHIN the grace window (renewal banner needs them)", () => {
      // ~3 days before NOW → inside the 7-day grace → kept so the paywall can
      // still surface "your access expired on X".
      const map = { recent: entry("recent", new Date("2026-05-20T00:00:00Z")) };
      const { map: out, pruned } = pruneExpiredMacaroons(map, NOW.getTime());
      expect(pruned).toBe(0);
      expect(out.recent).toBeDefined();
    });

    it("keeps still-valid entries", () => {
      const map = { valid: entry("valid", new Date("2026-06-10T00:00:00Z")) };
      const { map: out, pruned } = pruneExpiredMacaroons(map, NOW.getTime());
      expect(pruned).toBe(0);
      expect(out.valid).toBeDefined();
    });

    it("keeps entries whose exp can't be parsed (unknown freshness)", () => {
      const map = {
        bogus: { m: "totally-bogus--value", t: 1 },
        legacy: { m: "legacy-no-exp", t: 0 },
      };
      const { map: out, pruned } = pruneExpiredMacaroons(map, NOW.getTime());
      expect(pruned).toBe(0);
      expect(out.bogus).toBeDefined();
      expect(out.legacy).toBeDefined();
    });

    it("prunes only the long-expired entries from a mixed map", () => {
      const map = {
        valid: entry("valid", new Date("2026-06-10T00:00:00Z")),
        recent: entry("recent", new Date("2026-05-20T00:00:00Z")),
        old: entry("old", new Date("2026-05-01T00:00:00Z")),
        older: entry("older", new Date("2026-04-01T00:00:00Z")),
      };
      const { map: out, pruned } = pruneExpiredMacaroons(map, NOW.getTime());
      expect(pruned).toBe(2);
      expect(Object.keys(out).sort()).toEqual(["recent", "valid"]);
    });

    it("defaults `now` to Date.now() and grace to EXPIRY_GRACE_MS", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const map = {
        old: entry("old", new Date("2026-05-01T00:00:00Z")),
        recent: entry("recent", new Date("2026-05-20T00:00:00Z")),
      };
      const { map: out, pruned } = pruneExpiredMacaroons(map);
      expect(pruned).toBe(1);
      expect(out.old).toBeUndefined();
      expect(out.recent).toBeDefined();
      vi.useRealTimers();
    });

    it("returns an empty map unchanged", () => {
      expect(pruneExpiredMacaroons({}, NOW.getTime())).toEqual({
        map: {},
        pruned: 0,
      });
    });
  });
});
