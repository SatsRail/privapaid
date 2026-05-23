"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Single source of truth for "does this viewer have paid access to this
 * media?"
 *
 * Background — why this hook exists.
 *
 * Access state used to live in four components — PaymentWall, MediaHeader,
 * CommentSection, and MediaLayout — each running its own subset of the
 * checks. A periodic HeartbeatManager added a fifth race. A single portal
 * hiccup could revoke access mid-session in one component while the others
 * still believed everything was fine. That fragility was the source of
 * weeks of "image disappears" / "comments lock back up" / "timer doesn't
 * show until 30s later" bugs.
 *
 * The new model:
 *
 *   1. ONE check at mount via /api/media/[id]/unlock. The route is
 *      already in place, returns { key, encrypted_blob, product_id }
 *      when the cookie holds a verifiable macaroon, 401 otherwise.
 *   2. NO periodic re-verification. The macaroon TTL is the source of
 *      truth for how long access lasts; we don't second-guess it.
 *   3. Fresh payments call `claim()` to inject the access data the
 *      portal delivered in the checkout payload — no roundtrip needed
 *      to know we just paid.
 *   4. Write paths that get a 401 (comments POST, etc.) call `refresh()`
 *      to re-check from the server.
 *
 * Returns a discriminated union so consumers (MediaHeader, CommentSection,
 * PaymentWall) can branch cleanly: `loading` → render nothing, `inactive`
 * → render pay buttons, `active` → render content + clock + comment form.
 */

export interface MediaAccessProduct {
  productId: string;
  encryptedBlob?: string;
  keyFingerprint?: string;
}

export interface ActiveAccess {
  status: "active";
  productId: string;
  key: string;
  /** Server-provided remaining seconds at the moment of the most recent
   *  successful check. Drives the access clock pill. */
  remainingSeconds: number;
  /** Echo of `MediaProduct.encrypted_source_url` for the matched product —
   *  the bytes PaymentWall needs to decrypt content. */
  encryptedBlob: string;
}

export interface InactiveAccess {
  status: "inactive";
  /** Reason the most recent check returned no access. Mostly informational —
   *  components just see "no access" and render the paywall. */
  reason: "no_cookie" | "portal_rejected" | "transient" | "not_checked";
}

export interface LoadingAccess {
  status: "loading";
}

export type MediaAccess = LoadingAccess | ActiveAccess | InactiveAccess;

interface UseMediaAccessParams {
  mediaId: string;
  products: MediaAccessProduct[];
  /** Subset of product IDs that the server-rendered page found in the
   *  cookie. Empty array short-circuits the initial check to `inactive`. */
  storedProductIds: string[];
}

interface UseMediaAccessResult {
  access: MediaAccess;
  /**
   * Inject access state from a successful fresh-payment payload. Skips the
   * `/api/media/[id]/unlock` round-trip because we already have the key and
   * remaining seconds straight from the portal's checkout response.
   */
  claim(payload: {
    productId: string;
    key: string;
    remainingSeconds: number;
    encryptedBlob: string;
  }): void;
  /**
   * Re-run the server-side access check. Use when a privileged write (POST
   * comment, etc.) returns 401 — the local optimistic view may be stale.
   */
  refresh(): Promise<void>;
}

/**
 * Internal: run the access check against the server. Pulled out of the
 * hook so deps can be tracked by string identity (mediaId only) instead
 * of array references that change every render.
 */
async function fetchAccess(mediaId: string): Promise<MediaAccess> {
  try {
    const res = await fetch(`/api/media/${mediaId}/unlock`);
    if (res.status === 401) {
      return { status: "inactive", reason: "portal_rejected" };
    }
    if (!res.ok) {
      // Anything else (5xx, network shape mismatch) — treat as transient,
      // don't lock the user out, but also can't render content until a
      // refresh succeeds. UI shows the soft "couldn't verify" card.
      return { status: "inactive", reason: "transient" };
    }
    const data = (await res.json()) as {
      key?: string;
      key_fingerprint?: string;
      encrypted_blob?: string;
      product_id?: string;
      remaining_seconds?: number;
    };
    if (!data.key || !data.product_id || !data.encrypted_blob) {
      return { status: "inactive", reason: "transient" };
    }
    return {
      status: "active",
      productId: data.product_id,
      key: data.key,
      encryptedBlob: data.encrypted_blob,
      remainingSeconds: data.remaining_seconds ?? 0,
    };
  } catch {
    return { status: "inactive", reason: "transient" };
  }
}

export function useMediaAccess({
  mediaId,
  // `products` is part of the public API for future expansion (e.g., bundle
  // product matching) but the current implementation only needs mediaId +
  // storedProductIds.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  products: _products,
  storedProductIds,
}: UseMediaAccessParams): UseMediaAccessResult {
  // Derive a stable identity from the array so a new reference with the
  // same contents (which React parents create every render) doesn't
  // re-trigger the effect. This is the difference between a correct hook
  // and an infinite render loop.
  const storedKey = storedProductIds.join(",");

  const [access, setAccess] = useState<MediaAccess>(() =>
    storedKey === "" ? { status: "inactive", reason: "no_cookie" } : { status: "loading" }
  );

  // Adjust state on dep changes (mediaId or storedKey identity changed since
  // last render). This is the React-recommended pattern for prop-derived
  // state transitions — see https://react.dev/reference/react/useState#adjusting-state-when-a-prop-changes
  // It avoids the "setState in effect" smell that triggers cascading renders.
  const [depSnapshot, setDepSnapshot] = useState({ mediaId, storedKey });
  if (depSnapshot.mediaId !== mediaId || depSnapshot.storedKey !== storedKey) {
    setDepSnapshot({ mediaId, storedKey });
    setAccess(
      storedKey === ""
        ? { status: "inactive", reason: "no_cookie" }
        : { status: "loading" }
    );
  }

  // Fetch is the only async part; it stays in an effect because it has to.
  // The setState inside the .then is fine — it fires after an external event
  // (the fetch resolving), which is exactly what effects are for.
  useEffect(() => {
    if (storedKey === "") return;
    let cancelled = false;
    fetchAccess(mediaId).then((next) => {
      if (!cancelled) setAccess(next);
    });
    return () => {
      cancelled = true;
    };
  }, [mediaId, storedKey]);

  const claim = useCallback(
    ({
      productId,
      key,
      remainingSeconds,
      encryptedBlob,
    }: {
      productId: string;
      key: string;
      remainingSeconds: number;
      encryptedBlob: string;
    }) => {
      setAccess({
        status: "active",
        productId,
        key,
        remainingSeconds,
        encryptedBlob,
      });
    },
    []
  );

  const refresh = useCallback(async () => {
    const next = await fetchAccess(mediaId);
    setAccess(next);
  }, [mediaId]);

  return { access, claim, refresh };
}
