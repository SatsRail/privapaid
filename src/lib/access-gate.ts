/**
 * Centralized access-gating for paid content.
 *
 * Every endpoint and page that needs to know "which products cover this
 * media?" or "does the current request have a valid proof-of-payment?"
 * MUST use these two functions. Do not duplicate product lookups or
 * macaroon verification elsewhere.
 */

import { cookies } from "next/headers";
import { getInstanceConfig } from "@/config/instance";
import {
  parseMacaroonCookie,
  findMostRecentExpiry,
  isMacaroonExpired,
  COOKIE_NAME,
} from "@/lib/macaroon-cookie";
import { getMerchantKey } from "@/lib/merchant-key";
import { prisma } from "@/lib/prisma";

// ── Types ────────────────────────────────────────────────────────────

export interface GatedProduct {
  productId: string;
  encryptedBlob?: string;
  keyFingerprint?: string;
  /**
   * Server-side product lifecycle status: "active", "inactive", "archived",
   * or undefined for legacy rows. Surfaced so verification paths can keep
   * iterating archived products (existing payments must still grant access)
   * while purchase UIs filter to active-only.
   */
  status?: string;
}

export interface AccessResult {
  granted: boolean;
  reason?: "unavailable";
  productId?: string;
  key?: string;
  keyFingerprint?: string;
  remainingSeconds?: number;
  /** Local conservative deadline derived from SatsRail's authoritative bounds. */
  verifiedUntil?: number;
  retryAfterSeconds?: number;
}

// ── Product lookup ───────────────────────────────────────────────────

/**
 * Return every product that covers a given media item. This is the single
 * source of truth for "what products gate this content?"
 *
 * Reads from MediaProduct, which carries one row per (product, media).
 * The same media may be referenced by many rows when multiple products
 * unlock it (direct-sale + channel access, multiple tiers, etc.).
 *
 * By default, archived products are filtered out — purchase UIs should not
 * show buy buttons for products the merchant has explicitly retired. Pass
 * `{ includeArchived: true }` for verification paths where existing payments
 * must still grant access regardless of archival status (archiving a product
 * means "stop selling", not "revoke everyone's access").
 *
 * The filter is `productStatus != "archived"` — active, inactive, and
 * null all pass. This is intentional: a missing status field must never
 * lock out a paying customer.
 *
 * `channelId` is accepted for API compatibility with earlier callers but
 * is no longer needed for the lookup — the (productId, mediaId) join
 * already reaches all blobs regardless of scope.
 */
export async function getProductsForMedia(
  mediaId: string,
  _channelId: string,
  options: { includeArchived?: boolean } = {}
): Promise<GatedProduct[]> {
  const archivedProductFilter = options.includeArchived
    ? {}
    : { product: { productStatus: { not: "archived" } } };

  const blobs = await prisma.mediaProduct.findMany({
    where: {
      mediaId,
      ...archivedProductFilter,
    },
    select: {
      encryptedDek: true,
      keyFingerprint: true,
      product: {
        select: {
          satsrailProductId: true,
          productStatus: true,
        },
      },
    },
  });

  const products: GatedProduct[] = [];
  for (const b of blobs) {
    if (!b.encryptedDek) continue;
    products.push({
      productId: b.product.satsrailProductId,
      encryptedBlob: b.encryptedDek,
      keyFingerprint: b.keyFingerprint ?? undefined,
      status: b.product.productStatus ?? undefined,
    });
  }
  return products;
}

// ── SatsRail verify call ─────────────────────────────────────────────

/**
 * Discriminated outcome of a SatsRail token verification.
 *
 * Important: only `"invalid"` indicates a definitively rejected macaroon
 * (portal returned 402 Payment Required, or verified a different product).
 * Every other
 * non-success — 401 (merchant auth), 5xx, network errors, parse errors —
 * is reported as `"transient"` so callers do NOT delete the user's
 * macaroon over a hiccup that has nothing to do with their payment.
 */
export type VerifyOutcome =
  | {
      status: "valid";
      key?: string;
      keyFingerprint?: string;
      remainingSeconds: number;
      verifiedUntil?: number;
    }
  | { status: "invalid"; reason: "rejected_by_portal" | "product_mismatch" }
  | { status: "transient"; reason: "non_2xx" | "network" | "bad_body"; httpStatus?: number; retryAfterSeconds?: number };

/**
 * Verify a single access token against SatsRail's merchant API.
 *
 * The portal's `POST /api/v1/m/access/verify` returns:
 *   - 200 with `{ valid: true, product_id, remaining_seconds, key, key_fingerprint? }`
 *     when the macaroon is signature-valid and not expired. The verified
 *     product must match the requested product, not just the cookie's label.
 *   - 402 Payment Required when the macaroon is invalid OR expired.
 *     A verified product mismatch is also rejected.
 *   - 401 if the MERCHANT key is bad (not the user's macaroon).
 *   - 5xx / network errors on portal trouble.
 *
 * Used by both verifyMacaroonAccess and the macaroons PUT proxy.
 */
export async function verifySatsrailToken(
  accessToken: string,
  expectedProductId: string
): Promise<VerifyOutcome> {
  const config = await getInstanceConfig();
  const satsrailApiUrl = config.satsrail.apiUrl;
  const merchantKey = await getMerchantKey();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (merchantKey) headers["Authorization"] = `Bearer ${merchantKey}`;

  let res: Response;
  const requestedAt = Date.now();
  const monotonicStart = performance.now();
  try {
    res = await fetch(`${satsrailApiUrl}/m/access/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { status: "transient", reason: "network" };
  }

  if (res.status === 402) {
    return { status: "invalid", reason: "rejected_by_portal" };
  }

  if (!res.ok) {
    const retry = res.headers?.get("Retry-After");
    const seconds = retry && (/^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000);
    return { status: "transient", reason: "non_2xx", httpStatus: res.status,
      ...(seconds && Number.isFinite(seconds) ? { retryAfterSeconds: Math.max(1, Math.ceil(seconds)) } : {}) };
  }

  let data: { valid?: boolean; product_id?: string; remaining_seconds?: number; key?: string; key_fingerprint?: string; server_time?: number; expires_at?: number };
  try {
    data = await res.json();
  } catch {
    return { status: "transient", reason: "bad_body", httpStatus: res.status };
  }

  if (!data || data.valid !== true || typeof data.remaining_seconds !== "number" || !Number.isFinite(data.remaining_seconds) || data.remaining_seconds <= 0 || typeof data.product_id !== "string" || !data.product_id || typeof data.key !== "string" || !data.key) {
    // Unexpected — portal said 200 but body doesn't look right or is exhausted.
    // Be conservative: treat as transient so we don't nuke a possibly-valid cookie.
    return { status: "transient", reason: "bad_body", httpStatus: res.status };
  }

  // The cookie map is controlled by the browser. Only the signed token's
  // product identity, confirmed by the portal, can authorize this product.
  if (data.product_id !== expectedProductId) {
    return { status: "invalid", reason: "product_mismatch" };
  }

  let verifiedUntil: number | undefined;
  if (data.server_time !== undefined || data.expires_at !== undefined) {
    if (!Number.isSafeInteger(data.server_time) || !Number.isSafeInteger(data.expires_at) || data.expires_at! <= data.server_time! ||
        data.remaining_seconds > data.expires_at! - data.server_time!) return { status: "transient", reason: "bad_body", httpStatus: res.status };
    // Anchor the server TTL at request START, never receipt. Also subtract
    // monotonic RTT if the local wall clock moved backwards during verification.
    verifiedUntil = Math.min(requestedAt, Date.now() - (performance.now() - monotonicStart)) + data.remaining_seconds * 1000;
  }
  return {
    status: "valid",
    key: data.key,
    keyFingerprint: data.key_fingerprint,
    remainingSeconds: data.remaining_seconds,
    ...(verifiedUntil === undefined ? {} : { verifiedUntil }),
  };
}

// ── Macaroon verification ────────────────────────────────────────────

/**
 * Server-side helper: peek into the cookie and find the most-recent expiry
 * for any of the given product IDs. Used to surface "your access expired
 * on [date], pay to renew" in the paywall — turning the silent paywall
 * into a transparent renewal prompt.
 *
 * Reads the macaroon's encoded `exp` locally (Rails MessageVerifier), so
 * NO portal call is needed. Returns null when nothing in the cookie matches
 * the candidate products, or when everything that matches is still valid.
 */
export async function findExpiredAccessForProducts(
  productIds: string[]
): Promise<{ productId: string; expiredAt: Date } | null> {
  if (productIds.length === 0) return null;
  const cookieStore = await cookies();
  return findMostRecentExpiry(cookieStore.get(COOKIE_NAME)?.value, productIds);
}

/**
 * Check whether the current request holds a valid macaroon (proof of
 * payment) for any of the given product IDs. Iterates all candidates
 * and returns the first one that SatsRail confirms is still active.
 *
 * Returns `{ granted: false }` when no valid macaroon is found.
 */
export async function verifyMacaroonAccess(
  productIds: string[]
): Promise<AccessResult> {
  if (productIds.length === 0) return { granted: false };

  const cookieStore = await cookies();
  const macaroons = parseMacaroonCookie(cookieStore.get(COOKIE_NAME)?.value);

  // Verify in parallel. The portal call is the dominant cost (network
  // round-trip), so N serial awaits used to make a 5-product media item
  // wait for ~5x portal latency on cache miss. Promise.all collapses
  // that to one round-trip's worth.
  //
  // We preserve iteration order for the "first valid wins" tiebreak:
  // when a user has macaroons for multiple products that all gate the
  // same media, the earliest one in `productIds` wins (matches the
  // serial behavior).
  // Skip macaroons we can prove are expired by reading their own signed exp.
  // The portal enforces the same exp (MacaroonService.verify → 402), so
  // verifying a locally-dead macaroon is a wasted round-trip — and it keeps a
  // portal hiccup on a dead macaroon from wedging the paywall: a returning
  // viewer whose access lapsed resolves straight to "no access" (→ buy
  // buttons + the "expired on X" banner) instead of depending on a live verify
  // for a token that can't grant anyway. Unparseable exp is NOT skipped:
  // unknown freshness still goes to the portal.
  const now = Date.now();
  const present = productIds
    .map((pid) => ({ pid, m: macaroons[pid]?.m }))
    .filter((x): x is { pid: string; m: string } => !!x.m)
    .filter(({ m }) => !isMacaroonExpired(m, now));

  if (present.length === 0) return { granted: false };

  const results = await Promise.all(
    present.map(async ({ pid, m }) => ({
      pid,
      result: await verifySatsrailToken(m, pid),
    }))
  );

  for (const { pid, result } of results) {
    if (result.status === "valid") {
      return {
        granted: true,
        productId: pid,
        key: result.key,
        keyFingerprint: result.keyFingerprint,
        remainingSeconds: result.remainingSeconds,
        ...(result.verifiedUntil === undefined ? {} : { verifiedUntil: result.verifiedUntil }),
      };
    }
  }

  if (results.some(({ result }) => result.status === "transient")) {
    const retry = Math.max(0, ...results.map(({ result }) => result.status === "transient" ? result.retryAfterSeconds || 0 : 0));
    return { granted: false, reason: "unavailable", ...(retry ? { retryAfterSeconds: retry } : {}) };
  }
  return { granted: false };
}
