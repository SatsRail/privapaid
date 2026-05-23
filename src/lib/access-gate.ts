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
  COOKIE_NAME,
} from "@/lib/macaroon-cookie";
import { getMerchantKey } from "@/lib/merchant-key";
import MediaProduct from "@/models/MediaProduct";
import ChannelProduct from "@/models/ChannelProduct";

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
  productId?: string;
  key?: string;
  keyFingerprint?: string;
  remainingSeconds?: number;
}

// ── Product lookup ───────────────────────────────────────────────────

/**
 * Return every product (MediaProduct + ChannelProduct) that covers a given
 * media item. This is the single source of truth for "what products gate
 * this content?"
 *
 * By default, archived products are filtered out — purchase UIs should not
 * show buy buttons for products the merchant has explicitly retired. Pass
 * `{ includeArchived: true }` for verification paths where existing payments
 * must still grant access regardless of archival status (archiving a product
 * means "stop selling", not "revoke everyone's access").
 *
 * The filter is `product_status != "archived"` — active, inactive, and
 * undefined all pass. This is intentional: a missing status field must
 * never lock out a paying customer.
 */
export async function getProductsForMedia(
  mediaId: string,
  channelId: string,
  options: { includeArchived?: boolean } = {}
): Promise<GatedProduct[]> {
  const products: GatedProduct[] = [];
  // Only filter out archived when we're NOT including them. Inactive and
  // undefined-status products always pass — see the comment above.
  const statusFilter = options.includeArchived ? {} : { product_status: { $ne: "archived" } };

  const mediaProducts = await MediaProduct.find({
    media_id: mediaId,
    ...statusFilter,
  })
    .select("satsrail_product_id encrypted_source_url key_fingerprint product_status")
    .lean();

  for (const mp of mediaProducts) {
    if (mp.encrypted_source_url) {
      products.push({
        productId: mp.satsrail_product_id,
        encryptedBlob: mp.encrypted_source_url,
        keyFingerprint: mp.key_fingerprint,
        status: mp.product_status,
      });
    }
  }

  const channelProducts = await ChannelProduct.find({
    channel_id: channelId,
    "encrypted_media.media_id": mediaId,
    ...statusFilter,
  })
    .select("satsrail_product_id key_fingerprint encrypted_media product_status")
    .lean();

  for (const cp of channelProducts) {
    const entry = cp.encrypted_media.find(
      (em) => String(em.media_id) === String(mediaId)
    );
    if (entry?.encrypted_source_url) {
      products.push({
        productId: cp.satsrail_product_id,
        encryptedBlob: entry.encrypted_source_url,
        keyFingerprint: cp.key_fingerprint,
        status: cp.product_status,
      });
    }
  }

  return products;
}

// ── SatsRail verify call ─────────────────────────────────────────────

/**
 * Discriminated outcome of a SatsRail token verification.
 *
 * Important: only `"invalid"` indicates a definitively rejected macaroon
 * (portal returned 402 Payment Required, the only status the verify
 * endpoint uses to signal "this access token is dead"). Every other
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
    }
  | { status: "invalid"; reason: "rejected_by_portal" }
  | { status: "transient"; reason: "non_2xx" | "network" | "bad_body"; httpStatus?: number };

/**
 * Verify a single access token against SatsRail's merchant API.
 *
 * The portal's `POST /api/v1/m/access/verify` returns:
 *   - 200 with `{ valid: true, remaining_seconds, key?, key_fingerprint? }`
 *     when the macaroon is signature-valid and not expired.
 *   - 402 Payment Required when the macaroon is invalid OR expired.
 *     This is the ONLY signal we treat as "definitively rejected".
 *   - 401 if the MERCHANT key is bad (not the user's macaroon).
 *   - 5xx / network errors on portal trouble.
 *
 * Used by both verifyMacaroonAccess and the macaroons PUT proxy.
 */
export async function verifySatsrailToken(
  accessToken: string
): Promise<VerifyOutcome> {
  const config = await getInstanceConfig();
  const satsrailApiUrl = config.satsrail.apiUrl;
  const merchantKey = await getMerchantKey();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (merchantKey) headers["Authorization"] = `Bearer ${merchantKey}`;

  let res: Response;
  try {
    res = await fetch(`${satsrailApiUrl}/m/access/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ access_token: accessToken }),
    });
  } catch {
    return { status: "transient", reason: "network" };
  }

  if (res.status === 402) {
    return { status: "invalid", reason: "rejected_by_portal" };
  }

  if (!res.ok) {
    return { status: "transient", reason: "non_2xx", httpStatus: res.status };
  }

  let data: { valid?: boolean; remaining_seconds?: number; key?: string; key_fingerprint?: string };
  try {
    data = await res.json();
  } catch {
    return { status: "transient", reason: "bad_body", httpStatus: res.status };
  }

  if (data.valid !== true || typeof data.remaining_seconds !== "number" || data.remaining_seconds <= 0) {
    // Unexpected — portal said 200 but body doesn't look right or is exhausted.
    // Be conservative: treat as transient so we don't nuke a possibly-valid cookie.
    return { status: "transient", reason: "bad_body", httpStatus: res.status };
  }

  return {
    status: "valid",
    key: data.key,
    keyFingerprint: data.key_fingerprint,
    remainingSeconds: data.remaining_seconds,
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

  for (const pid of productIds) {
    const macaroon = macaroons[pid];
    if (!macaroon) continue;

    const result = await verifySatsrailToken(macaroon);
    if (result.status === "valid") {
      return {
        granted: true,
        productId: pid,
        key: result.key,
        keyFingerprint: result.keyFingerprint,
        remainingSeconds: result.remainingSeconds,
      };
    }
    // status: "invalid" or "transient" — try next product
  }

  return { granted: false };
}
