/**
 * Shared macaroon cookie utilities.
 *
 * The `satsrail_macaroons` httpOnly cookie stores a JSON map of
 * `{ product_id: macaroon_string }`. These helpers parse and filter
 * that map so callers avoid duplicating the logic.
 */

export const COOKIE_NAME = "satsrail_macaroons";
export const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year

/**
 * Parse the raw cookie value into a product-id → macaroon map.
 * Returns an empty object on missing or malformed input.
 */
export function parseMacaroonCookie(
  raw: string | undefined
): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Return the subset of `candidateIds` that have a stored macaroon.
 * Used by the server component to tell PaymentWall which products
 * are worth verifying against SatsRail.
 */
export function getStoredProductIds(
  cookieValue: string | undefined,
  candidateIds: string[]
): string[] {
  const store = parseMacaroonCookie(cookieValue);
  return candidateIds.filter((id) => !!store[id]);
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
 * Lets us:
 *   1. Skip portal calls for obviously-expired macaroons (cheap optimization).
 *   2. Tell the user "your access expired on [date]" without asking the portal.
 *
 * The macaroon format is `base64(payload)--signature`, where payload is a
 * JSON object with shape:
 *   { _rails: { data: {...}, exp: "ISO-8601", pur: "access_token" } }
 *
 * Returns null on any malformed input — callers treat that as "unknown
 * expiry" rather than crashing. Never throws.
 */
export function parseMacaroonExp(macaroon: string): Date | null {
  if (!macaroon || typeof macaroon !== "string") return null;
  const sepIdx = macaroon.indexOf("--");
  const b64Payload = sepIdx > 0 ? macaroon.slice(0, sepIdx) : macaroon;
  try {
    // Rails base64 encoding may use either standard `+/=` or URL-safe `-_`.
    // Buffer.from handles standard; normalize URL-safe to standard first.
    const normalized = b64Payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as {
      _rails?: { exp?: string; data?: { exp?: number } };
    };
    // Prefer the outer `_rails.exp` (ISO string) — that's what Rails uses
    // for the cookie expiry. Fall back to the inner numeric exp if needed.
    const iso = parsed?._rails?.exp;
    if (iso) {
      const d = new Date(iso);
      return isNaN(d.getTime()) ? null : d;
    }
    const innerExp = parsed?._rails?.data?.exp;
    if (typeof innerExp === "number") {
      // Unix seconds → ms.
      return new Date(innerExp * 1000);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * For a cookie value and a list of candidate product IDs, return the
 * most-recent expiry date among matching macaroons whose exp is in the
 * past. Returns null when nothing matches or everything is still valid.
 *
 * "Most-recent" so when a user has paid for the same product multiple
 * times, we show them the latest expiry rather than a stale one. The
 * cookie only holds one macaroon per product so this is mostly relevant
 * across DIFFERENT products that cover the same media.
 */
export function findMostRecentExpiry(
  cookieValue: string | undefined,
  candidateIds: string[]
): { productId: string; expiredAt: Date } | null {
  const store = parseMacaroonCookie(cookieValue);
  const now = new Date();
  let mostRecent: { productId: string; expiredAt: Date } | null = null;
  for (const id of candidateIds) {
    const mac = store[id];
    if (!mac) continue;
    const exp = parseMacaroonExp(mac);
    if (!exp || exp >= now) continue;
    if (!mostRecent || exp > mostRecent.expiredAt) {
      mostRecent = { productId: id, expiredAt: exp };
    }
  }
  return mostRecent;
}
