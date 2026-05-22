import * as Sentry from "@sentry/nextjs";
import { verifyKeyFingerprint } from "@/lib/client-crypto";

/**
 * Mount-time verification of stored macaroons.
 *
 * When a returning customer loads a paid-content page, PaymentWall has to
 * answer one question: "do they already have access?" The answer comes from
 * two server-side calls in order:
 *
 *   1. For each product the server confirmed has a macaroon in the cookie,
 *      PUT /api/macaroons to verify with SatsRail and get a fresh key. On
 *      a valid macaroon we decrypt and we're done.
 *   2. Otherwise, GET /api/media/[id]/unlock which performs the same
 *      verification server-side. Some deployments only set the cookie
 *      after the fact, so this fallback catches them.
 *
 * Outcomes:
 *   `unlocked`           — we have plaintext bytes to render
 *   `transient_failure`  — something hiccupped (502, network, fingerprint
 *                          mismatch) and the customer should reload, NOT
 *                          re-pay. Surfaces the "couldn't verify" card.
 *   `no_access`          — nothing wrong, just nothing to unlock. Show
 *                          the pay buttons as if it were a first visit.
 *
 * Kept as a pure async function (not a hook) so it can be unit-tested
 * with plain mocks instead of React Testing Library.
 */

export interface AccessProduct {
  productId: string;
  encryptedBlob: string;
  keyFingerprint?: string;
}

export type AccessOutcome =
  | {
      kind: "unlocked";
      productId: string;
      bytes: Uint8Array;
      remainingSeconds: number | null;
    }
  | { kind: "transient_failure" }
  | { kind: "no_access" };

type ResolveContent = (
  encryptedBlob: string,
  key: string,
  productId: string
) => Promise<Uint8Array>;

interface CheckArgs {
  mediaId: string;
  products: AccessProduct[];
  storedProductIds: string[];
  resolveContent: ResolveContent;
}

export async function checkStoredMacaroonAccess(
  args: CheckArgs
): Promise<AccessOutcome> {
  const { mediaId, products, storedProductIds, resolveContent } = args;

  // Track whether we saw a TRANSIENT failure signal (502, network, or
  // surprising response shape). On a transient, the user's stored macaroon
  // is likely still valid — show a "couldn't verify" card so they don't
  // think they need to re-pay. Definitive rejections (410) mean the cookie
  // was cleaned server-side; fall through to pay buttons.
  let sawTransient = false;

  // 1. Try stored macaroons — only for products the server found in the cookie.
  const candidates = storedProductIds.length > 0
    ? products.filter((p) => storedProductIds.includes(p.productId))
    : [];

  for (const product of candidates) {
    try {
      const res = await fetch("/api/macaroons", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: product.productId }),
      });

      if (!res.ok) {
        if (res.status === 502) sawTransient = true;
        // 410 = definitive rejection — cookie cleaned, fall through to pay buttons.
        continue;
      }

      const data = await res.json();
      const fingerprint = data.key_fingerprint || product.keyFingerprint;
      if (!(await verifyKeyFingerprint(data.key, fingerprint))) {
        // Wrong key delivered or key rotation in progress. Treat as transient.
        sawTransient = true;
        continue;
      }

      const bytes = await resolveContent(
        product.encryptedBlob,
        data.key,
        product.productId
      );
      return {
        kind: "unlocked",
        productId: product.productId,
        bytes,
        remainingSeconds: data.remaining_seconds ?? null,
      };
    } catch {
      sawTransient = true;
    }
  }

  // 2. Fall back to the server-side direct unlock endpoint.
  try {
    const unlockRes = await fetch(`/api/media/${mediaId}/unlock`);
    if (unlockRes.ok) {
      const data = await unlockRes.json();
      const product =
        products.find((p) => p.encryptedBlob === data.encrypted_blob) ||
        products[0];
      if (product) {
        const fingerprint = data.key_fingerprint || product.keyFingerprint;
        if (await verifyKeyFingerprint(data.key, fingerprint)) {
          const bytes = await resolveContent(
            data.encrypted_blob,
            data.key,
            data.product_id
          );
          return {
            kind: "unlocked",
            productId: product.productId,
            bytes,
            remainingSeconds: data.remaining_seconds ?? null,
          };
        }
        sawTransient = true;
      }
    } else if (unlockRes.status >= 500) {
      sawTransient = true;
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { context: "PaymentWall.directUnlock" },
      extra: { mediaId },
    });
    sawTransient = true;
  }

  return sawTransient ? { kind: "transient_failure" } : { kind: "no_access" };
}
