/**
 * Shared macaroon cookie utilities.
 *
 * The `satsrail_macaroons` httpOnly cookie stores a JSON map of
 * product-id → entry. Two entry shapes are supported so we can roll
 * forward without invalidating user state:
 *
 *   - Legacy: `{ product_id: macaroon_string }`
 *   - Current: `{ product_id: { m: macaroon_string, t: storedAt_ms } }`
 *
 * The current shape carries the issuance time so the cookie can evict
 * the oldest entries when it would otherwise blow past the browser's
 * ~4KB single-cookie limit. Legacy entries are migrated lazily on the
 * next POST.
 */

import { z } from "zod";

export const COOKIE_NAME = "satsrail_macaroons";
export const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year

/**
 * Hard caps on the stored map. The browser hard-limit is roughly 4096
 * bytes per cookie (RFC 6265, enforced strictly by Chrome — Safari is
 * more lenient). MAX_BYTES is the raw JSON length budget; we leave a
 * generous ~1500-byte cushion for:
 *
 *   - Percent-encoding overhead in Set-Cookie (URL-safe JSON adds 20–30%
 *     after encoding `{`, `}`, `"`, etc.)
 *   - Cookie attributes (Max-Age, Path, SameSite, HttpOnly, Secure ~ 90B)
 *   - Header framing
 *   - A small future-proofing margin so adding ~1 average macaroon doesn't
 *     immediately push the next user over the line.
 *
 * Cause-of-pain log: we discovered users accumulating 6+ macaroons in
 * Chrome would silently lose access on the *next* purchase because the
 * full Set-Cookie header exceeded Chrome's per-cookie limit and got
 * dropped. Lowering MAX_BYTES from 3000 → 2500 trades extra eviction
 * (LRU-by-storage-time, never the just-added entry) for reliable writes.
 * MAX_ENTRIES is a defense-in-depth ceiling in case a single abnormally-
 * long macaroon slips past the byte budget.
 */
export const MAX_ENTRIES = 100;
export const MAX_BYTES = 2500;

/**
 * Grace period after a macaroon's own signed expiry before we physically
 * evict it from the cookie. We keep recently-expired entries around so the
 * paywall can still render "your access expired on <date>, pay to renew"
 * (findMostRecentExpiry needs the entry present to read its exp). Past the
 * grace window the entry is dead weight: verifyMacaroonAccess already skips
 * it locally so it never reaches the portal, and there's no UX left to serve
 * — so drop it rather than carrying it for the cookie's full 1-year life.
 */
export const EXPIRY_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const EntrySchema = z.union([
  z.string(),
  z.object({ m: z.string(), t: z.number() }),
]);
const CookieSchema = z.record(z.string(), EntrySchema);

export interface MacaroonEntry {
  m: string;
  t: number;
}

export type MacaroonMap = Record<string, MacaroonEntry>;

/**
 * Parse the raw cookie value into a normalized product-id → entry map.
 *
 * Legacy entries (plain strings) are upgraded to `{m, t: 0}` so callers
 * can rely on the unified shape. `t: 0` makes legacy entries the first
 * to be evicted when room is needed — they have unknown freshness, so
 * preferring newer entries is the safe call.
 *
 * Returns an empty object on missing, malformed, or schema-violating
 * input. Never throws.
 */
export function parseMacaroonCookie(raw: string | undefined): MacaroonMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = CookieSchema.safeParse(parsed);
  if (!result.success) return {};

  const out: MacaroonMap = {};
  for (const [pid, entry] of Object.entries(result.data)) {
    if (typeof entry === "string") {
      out[pid] = { m: entry, t: 0 };
    } else {
      out[pid] = entry;
    }
  }
  return out;
}

/**
 * Serialize a normalized map back to the wire shape.
 */
export function serializeMacaroonCookie(map: MacaroonMap): string {
  return JSON.stringify(map);
}

/**
 * Insert `{m: macaroon, t: now}` into the map and ensure it still fits
 * the caps. If the resulting serialization would exceed `MAX_BYTES` or
 * `MAX_ENTRIES`, evict by ascending `t` (oldest first) until it fits.
 *
 * Returns the mutated map and a count of evicted entries.
 *
 * Throws when the new entry alone exceeds `MAX_BYTES` — that shouldn't
 * happen for valid macaroons (~250 bytes) but we surface it loudly so
 * the API route can return a 413.
 */
export function insertWithCap(
  map: MacaroonMap,
  productId: string,
  macaroon: string,
  now: number
): { map: MacaroonMap; evicted: number } {
  const next: MacaroonMap = { ...map, [productId]: { m: macaroon, t: now } };

  // Quick check on the new entry alone.
  const singleBytes = JSON.stringify({ [productId]: next[productId] }).length;
  if (singleBytes > MAX_BYTES) {
    throw new Error("MACAROON_TOO_LARGE");
  }

  let evicted = 0;
  while (
    Object.keys(next).length > MAX_ENTRIES ||
    serializeMacaroonCookie(next).length > MAX_BYTES
  ) {
    // Find the oldest entry that isn't the one we just inserted.
    let oldestPid: string | null = null;
    let oldestT = Infinity;
    for (const [pid, entry] of Object.entries(next)) {
      if (pid === productId) continue;
      if (entry.t < oldestT) {
        oldestT = entry.t;
        oldestPid = pid;
      }
    }
    if (!oldestPid) break;
    delete next[oldestPid];
    evicted++;
  }

  return { map: next, evicted };
}

/**
 * Return the subset of `candidateIds` that have a stored macaroon.
 */
export function getStoredProductIds(
  cookieValue: string | undefined,
  candidateIds: string[]
): string[] {
  const store = parseMacaroonCookie(cookieValue);
  return candidateIds.filter((id) => !!store[id]?.m);
}

/**
 * Convenience: return the macaroon string for a product, or undefined.
 */
export function getMacaroon(
  cookieValue: string | undefined,
  productId: string
): string | undefined {
  return parseMacaroonCookie(cookieValue)[productId]?.m;
}

/**
 * Parse the encoded expiration date from a Rails MessageVerifier macaroon
 * WITHOUT verifying the signature.
 *
 * The portal signs macaroons with its own SECRET_KEY_BASE; we don't have
 * that key on the stream side, so we can't verify here. But we CAN safely
 * read the encoded `exp` field — the user can't lie about it (they'd need
 * the signing key to forge anything the portal would accept), so if the
 * encoded exp is in the past, we know for sure the portal would reject it.
 *
 * Returns null on any malformed input — callers treat that as "unknown
 * expiry" rather than crashing. Never throws.
 */
export function parseMacaroonExp(macaroon: string): Date | null {
  if (!macaroon || typeof macaroon !== "string") return null;
  const sepIdx = macaroon.indexOf("--");
  const b64Payload = sepIdx > 0 ? macaroon.slice(0, sepIdx) : macaroon;
  try {
    const normalized = b64Payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as {
      _rails?: { exp?: string; data?: { exp?: number } };
    };
    const iso = parsed?._rails?.exp;
    if (iso) {
      const d = new Date(iso);
      return isNaN(d.getTime()) ? null : d;
    }
    const innerExp = parsed?._rails?.data?.exp;
    if (typeof innerExp === "number") {
      return new Date(innerExp * 1000);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether a stored macaroon's own signed expiry is at or before `now`.
 *
 * Reads the encoded `exp` locally (no portal call). The portal enforces the
 * SAME exp on its side — MacaroonService.verify rejects an expired token with
 * HTTP 402 — so a `true` here is provably equivalent to "the portal would
 * reject this." Returns `false` when the exp can't be parsed: an unknown
 * expiry must be left for the portal to judge, never assumed dead.
 */
export function isMacaroonExpired(
  macaroon: string,
  now: number = Date.now()
): boolean {
  const exp = parseMacaroonExp(macaroon);
  return exp !== null && exp.getTime() <= now;
}

/**
 * Drop entries whose macaroon expired more than `graceMs` ago. Entries that
 * are still valid, expired within the grace window, or have an unparseable
 * exp are KEPT — the first two still serve the renewal banner, and unknown
 * freshness is left for the portal to judge. Returns the pruned map and a
 * count of removed entries. Pure; never throws.
 */
export function pruneExpiredMacaroons(
  map: MacaroonMap,
  now: number = Date.now(),
  graceMs: number = EXPIRY_GRACE_MS
): { map: MacaroonMap; pruned: number } {
  const cutoff = now - graceMs;
  const out: MacaroonMap = {};
  let pruned = 0;
  for (const [pid, entry] of Object.entries(map)) {
    const exp = parseMacaroonExp(entry.m);
    if (exp !== null && exp.getTime() <= cutoff) {
      pruned++;
      continue;
    }
    out[pid] = entry;
  }
  return { map: out, pruned };
}

/**
 * For a cookie value and a list of candidate product IDs, return the
 * most-recent expiry date among matching macaroons whose exp is in the
 * past. Returns null when nothing matches or everything is still valid.
 */
export function findMostRecentExpiry(
  cookieValue: string | undefined,
  candidateIds: string[]
): { productId: string; expiredAt: Date } | null {
  const store = parseMacaroonCookie(cookieValue);
  const now = new Date();
  let mostRecent: { productId: string; expiredAt: Date } | null = null;
  for (const id of candidateIds) {
    const entry = store[id];
    if (!entry?.m) continue;
    const exp = parseMacaroonExp(entry.m);
    if (!exp || exp >= now) continue;
    if (!mostRecent || exp > mostRecent.expiredAt) {
      mostRecent = { productId: id, expiredAt: exp };
    }
  }
  return mostRecent;
}
