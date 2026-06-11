"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  base64urlToBytes,
  decryptBlob,
  decryptBytesWithKey,
  verifyKeyFingerprint,
} from "@/lib/client-crypto";
import * as Sentry from "@sentry/nextjs";
import CheckoutOverlay from "@/components/CheckoutOverlay";
import ContentRenderer from "@/components/ContentRenderer";
import ExchangeModal from "@/components/ExchangeModal";
import UnlockFailureCard from "@/components/UnlockFailureCard";
import VerifyFailureCard from "@/components/VerifyFailureCard";
import ProductButtons, { type PaywallProduct } from "@/components/paywall/ProductButtons";
import CheckingAccessPlaceholder from "@/components/paywall/CheckingAccessPlaceholder";
import PaywallFrame from "@/components/paywall/PaywallFrame";
import { useLocale } from "@/i18n/useLocale";
import type { MediaAccess } from "@/lib/use-media-access";
import { resolvePaywallView } from "@/lib/paywall-view";

type Product = PaywallProduct;

interface PaymentWallProps {
  mediaId: string;
  products: Product[];
  /**
   * Access state from the parent's `useMediaAccess` hook. PaymentWall reads
   * from this and never runs its own verification — that's the architectural
   * change that eliminated the multi-component race conditions we used to
   * have. When `access.status === "active"` we have the key and the
   * encryptedBlob; this component just decrypts and renders.
   */
  access: MediaAccess;
  /**
   * Called after a fresh payment to inject the access state synchronously,
   * without a server roundtrip. Parent's hook updates → access prop
   * transitions to "active" → the decrypt effect below fires.
   */
  onAccessClaim: (params: {
    productId: string;
    key: string;
    remainingSeconds: number;
    encryptedBlob: string;
  }) => void;
  thumbnailUrl?: string;
  mediaType: string;
  /** The media's MediaEnvelope row id (every media has exactly one). */
  envelopeId?: string;
  merchantLogo?: string;
  merchantName?: string;
}

/** Media types that should show artwork/thumbnail alongside the player */
const ARTWORK_TYPES = new Set(["audio", "podcast"]);

/**
 * Allowlisted content-integrity reasons the client may report to
 * /api/media/[id]/report-error. Mirrors the server's ALLOWED_REASONS. The
 * fingerprint-mismatch case is reported directly (it isn't a thrown decrypt
 * error), so it's not produced by classifyDecryptFailure below.
 */
type ReportReason =
  | "integrity_auth_failed"
  | "missing_envelope_id"
  | "key_length_invalid"
  | "blob_too_short";

/**
 * Map a decrypt failure to an allowlisted integrity reason, or null when the
 * failure is transient/unknown and must NOT flag the media. A null result
 * means "still capture in Sentry, but don't report" — the server only flags
 * content it can independently confirm is broken, and we never want a network
 * blip (e.g. the envelope fetch) to take good content offline.
 */
function classifyDecryptFailure(err: unknown): ReportReason | null {
  const msg = err instanceof Error ? err.message : String(err);
  // Envelope fetch failure is availability, not content integrity.
  if (msg.startsWith("Failed to fetch encrypted envelope")) return null;
  if (msg.includes("missing its envelope id")) return "missing_envelope_id";
  if (msg.includes("Key must be 32 bytes")) return "key_length_invalid";
  if (msg.includes("Blob too short")) return "blob_too_short";
  // Web Crypto rejects decrypt with an OperationError DOMException when the
  // AES-GCM auth tag fails — the ciphertext or key is wrong (integrity).
  if (err instanceof DOMException && err.name === "OperationError") {
    return "integrity_auth_failed";
  }
  if (msg.includes("OperationError")) return "integrity_auth_failed";
  // Unknown — be conservative; Sentry still has it.
  return null;
}

export default function PaymentWall({
  mediaId,
  products,
  access,
  onAccessClaim,
  thumbnailUrl,
  mediaType,
  envelopeId,
  merchantLogo,
  merchantName,
}: PaymentWallProps) {
  const { t } = useLocale();
  const [decryptedBytes, setDecryptedBytes] = useState<Uint8Array | null>(null);
  const [checkoutToken, setCheckoutToken] = useState<string | null>(null);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exchangeModalOpen, setExchangeModalOpen] = useState(false);
  const [unlockFailure, setUnlockFailure] = useState<{
    orderNumber: string | null;
    orderId: string | null;
    failedAt: number;
  } | null>(null);
  // Remembers the most recent payment's order identifiers across the access
  // claim → decryption effect transition. If decryption blows up on the
  // freshly-claimed access, the failure card still shows the customer's order
  // reference even though the decryption effect itself has no direct view of
  // handleCheckoutComplete's locals. Stays null for already-active access on
  // mount (refresh case), which is correct — no payment just happened.
  const lastPaymentRef = useRef<{ orderNumber: string | null; orderId: string | null } | null>(null);

  // Every failure report in this component shares the same identity envelope
  // (mediaId, activeProductId, mediaType). These wrappers fold the boilerplate
  // so adding instrumentation is a one-liner. No-ops when Sentry is disabled.
  const reportException = useCallback(
    (context: string, err: unknown, extra: Record<string, unknown> = {}) => {
      Sentry.captureException(err, {
        tags: { context, mediaType },
        extra: { mediaId, activeProductId, mediaType, ...extra },
      });
    },
    [mediaId, activeProductId, mediaType]
  );

  const reportMessage = useCallback(
    (
      context: string,
      message: string,
      level: "error" | "warning" | "info" = "error",
      extra: Record<string, unknown> = {},
      extraTags: Record<string, string> = {}
    ) => {
      Sentry.captureMessage(message, {
        level,
        tags: { context, mediaType, ...extraTags },
        extra: { mediaId, activeProductId, mediaType, ...extra },
      });
    },
    [mediaId, activeProductId, mediaType]
  );

  // Best-effort report of a content-integrity failure to the server, which
  // re-decrypts to confirm before it flags the media. Fire-and-forget: never
  // blocks, never surfaces to the viewer, and swallows its own errors. Sentry
  // remains the primary signal; this just lets a confirmed-broken asset flip
  // to "unavailable" and stop hitting the portal. Only call with a reason that
  // passed classifyDecryptFailure (or the fingerprint-mismatch case).
  const reportDecryptError = useCallback(
    (
      reason: ReportReason | "key_fingerprint_mismatch",
      productId: string | null,
      orderId: string | null
    ) => {
      void fetch(`/api/media/${mediaId}/report-error`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason,
          ...(productId ? { productId } : {}),
          ...(orderId ? { orderId } : {}),
        }),
      }).catch(() => {
        // Best-effort — reporting must never affect the viewer.
      });
    },
    [mediaId]
  );

  // Unwrap encrypted content into displayable bytes. Every media uses the same
  // two-step flow: the encrypted blob holds the per-media DEK — unwrap it with
  // the product key, fetch the ciphertext from the envelope route, then decrypt
  // with the DEK. For url media the decrypted payload is the source URL string;
  // for photo/article it's the content bytes (ContentRenderer branches on type).
  const resolveContent = useCallback(
    async (encryptedBlob: string, key: string, productId: string): Promise<Uint8Array> => {
      // Step 1: unwrap the per-media DEK with the product key (AAD = productId).
      const inner = await decryptBlob(encryptedBlob, key, productId);
      if (!envelopeId) {
        throw new Error("media is missing its envelope id");
      }
      // `inner` is the UTF-8 bytes of the base64url DEK; decode it to 32 raw bytes.
      const dekBase64url = new TextDecoder().decode(inner);
      const dekBytes = base64urlToBytes(dekBase64url);
      // Step 2: fetch the envelope ciphertext and decrypt it with the DEK.
      const res = await fetch(`/api/envelopes/${envelopeId}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch encrypted envelope: ${res.status}`);
      }
      const ciphertext = new Uint8Array(await res.arrayBuffer());
      return decryptBytesWithKey(ciphertext, dekBytes);
    },
    [envelopeId]
  );

  // Decryption effect: whenever access becomes active, attempt to decrypt
  // and render. This is the SECOND step of the founder's two-step model
  //   1. Access exists → show clock + comments (parent's job, via hook)
  //   2. Decrypt → requires access, fetch key from access state (this)
  // If access becomes inactive (expiry, portal rejection on refresh), we
  // clear the decrypted bytes so the paywall returns.
  useEffect(() => {
    let cancelled = false;
    if (access.status !== "active") {
      setDecryptedBytes(null);
      setActiveProductId(null);
      return;
    }

    // Don't re-decrypt for the same key — prevents iframe/video restart
    // on a benign access-state refresh.
    if (activeProductId === access.productId && decryptedBytes) {
      return;
    }

    resolveContent(access.encryptedBlob, access.key, access.productId)
      .then((bytes) => {
        if (cancelled) return;
        setDecryptedBytes(bytes);
        setActiveProductId(access.productId);
      })
      .catch((err) => {
        if (cancelled) return;
        // Active access but decryption blew up — the macaroon is valid,
        // we received a key, but `resolveContent` threw. Surface this
        // because it's exactly the "I paid but content won't load"
        // moment the customer cares about.
        Sentry.captureException(err, {
          tags: { context: "PaymentWall.decryptOnAccess", mediaType },
          extra: {
            mediaId,
            activeProductId: access.productId,
            mediaType,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
        const last = lastPaymentRef.current;
        // Report only confirmed-integrity failures — never transient ones
        // (e.g. a failed envelope fetch). The server re-confirms before it
        // flags the media, so a false report here is harmless, but filtering
        // transients keeps the portal-protection signal clean.
        const reason = classifyDecryptFailure(err);
        if (reason) {
          reportDecryptError(reason, access.productId, last?.orderId ?? null);
        }
        setUnlockFailure({
          orderNumber: last?.orderNumber ?? null,
          orderId: last?.orderId ?? null,
          failedAt: Date.now(),
        });
      });

    return () => {
      cancelled = true;
    };
    // `access` is a discriminated union; if its identity changes we re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access.status, access.status === "active" ? access.productId : null, access.status === "active" ? access.key : null]);

  // Clear stale failure state once content is rendered.
  useEffect(() => {
    if (decryptedBytes) {
      setUnlockFailure(null);
    }
  }, [decryptedBytes]);

  async function handleUnlock(productId: string) {
    setLoading(true);
    setError("");

    try {
      // Create checkout session via our API (server-side uses sk_live)
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_id: mediaId,
          product_id: productId,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error || t("viewer.payment.checkout_failed"));
        return;
      }

      setActiveProductId(productId);
      setCheckoutToken(json.token);
    } catch (err) {
      Sentry.captureException(err, { tags: { context: "PaymentWall.checkout" }, extra: { mediaId, productId } });
      setError(t("viewer.payment.error"));
    } finally {
      setLoading(false);
    }
  }

  const handleCheckoutComplete = useCallback(
    async (data: {
      key: string;
      macaroon: string;
      remaining_seconds?: number;
      order_number: string | null;
      order_id: string | null;
    }) => {
      if (!activeProductId) {
        setCheckoutToken(null);
        return;
      }

      const orderNumber = data.order_number ?? null;
      const orderId = data.order_id ?? null;
      // One Sentry event per customer-visible failure, tagged with the branch
      // (`reason`) and the order ids so we can cross-reference the Lightning
      // payment. The reason rides on the tag so Sentry filters can pivot on it.
      const recordFailure = (reason: string) => {
        reportMessage(
          "PaymentWall.recordFailure",
          "PaymentWall.recordFailure",
          "error",
          {
            orderId,
            orderNumber,
            hadKey: !!data.key,
            hadMacaroon: !!data.macaroon,
          },
          { reason }
        );
        setUnlockFailure({ orderNumber, orderId, failedAt: Date.now() });
        setError("");
        setCheckoutToken(null);
      };

      // Store macaroon in httpOnly cookie. Even though `onAccessClaim`
      // below sets the in-memory access state synchronously, the cookie
      // is what survives page refreshes — without it, the user is back to
      // the paywall on reload.
      if (data.macaroon) {
        try {
          const macRes = await fetch("/api/macaroons", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              product_id: activeProductId,
              macaroon: data.macaroon,
            }),
          });
          if (!macRes.ok) {
            reportMessage(
              "PaymentWall.macaroonStore",
              "Failed to store macaroon (non-2xx)",
              "error",
              { status: macRes.status }
            );
          }
        } catch (err) {
          reportException("PaymentWall.macaroonStore", err);
        }
      } else {
        reportMessage(
          "PaymentWall.checkout",
          "Checkout completed with empty macaroon",
          "warning",
          { hasKey: !!data.key }
        );
      }

      const product = products.find((p) => p.productId === activeProductId);
      if (!product) {
        reportMessage(
          "PaymentWall.missingProduct",
          "Checkout completed but product missing in PaymentWall",
          "error"
        );
        recordFailure("missingProduct");
        return;
      }

      if (!data.key) {
        recordFailure("noKeyFromPortal");
        return;
      }

      if (!(await verifyKeyFingerprint(data.key, product.keyFingerprint))) {
        reportMessage(
          "PaymentWall.fingerprint",
          "Key fingerprint mismatch after payment",
          "error"
        );
        // The key the portal returned doesn't match the blob's fingerprint —
        // a content-integrity mismatch the server can confirm. Report it so
        // the media can flip to "unavailable" if the server agrees.
        reportDecryptError("key_fingerprint_mismatch", activeProductId, orderId);
        recordFailure("fingerprintMismatch");
        return;
      }

      // Inject access state into the parent's hook — this is the single
      // place we "activate" access. The decrypt effect above will fire
      // automatically as access becomes active, attempt decryption, and
      // either set decryptedBytes (success) or set unlockFailure (failure).
      // We deliberately do NOT decrypt inline here anymore; that's the
      // decrypt effect's job, and centralizing it eliminates the two-path
      // divergence we had before (direct + fallback).
      //
      // Stash the order ids before claiming so the decrypt effect's failure
      // path can surface them on UnlockFailureCard if decryption blows up.
      lastPaymentRef.current = { orderNumber, orderId };
      onAccessClaim({
        productId: product.productId,
        key: data.key,
        remainingSeconds: data.remaining_seconds ?? 0,
        encryptedBlob: product.encryptedBlob,
      });
      setCheckoutToken(null);
    },
    [activeProductId, products, reportException, reportMessage, reportDecryptError, onAccessClaim]
  );

  // Single source of truth for which surface renders — see resolvePaywallView
  // for the full precedence (content > unlock_failure > verify_failure >
  // buttons > checking).
  const view = resolvePaywallView({
    hasDecryptedContent: decryptedBytes !== null,
    access,
    hasUnlockFailure: unlockFailure !== null,
  });

  // `&& decryptedBytes` is always true when the view is "content" (the selector
  // derives it from the same flag); it's here only to narrow the type for
  // ContentRenderer, which needs non-null bytes.
  if (view.kind === "content" && decryptedBytes) {
    return (
      <div className="mb-6">
        {ARTWORK_TYPES.has(mediaType) && thumbnailUrl && (
          <div className="mb-4 flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbnailUrl}
              alt="Artwork"
              className="max-h-80 w-full max-w-sm rounded-lg object-cover"
            />
          </div>
        )}
        <ContentRenderer
          decryptedBytes={decryptedBytes}
          mediaType={mediaType}
        />
        {/*
          No HeartbeatManager. Periodic re-verification was the source of
          "image disappears after a minute" — a single portal hiccup could
          revoke fresh access. The macaroon's own TTL is now the source of
          truth; we trust it for the session and re-verify only on the
          next page load.
        */}
      </div>
    );
  }

  // Surface "your access expired on [date], pay to renew" above the unlock
  // buttons when the cookie holds an expired macaroon. This is the
  // "returning visitor whose subscription lapsed" case — used to render a
  // silent paywall; now it explains why they need to pay again.
  const expiredAccessAt =
    access.status === "inactive" ? access.expiredAt : undefined;

  const reload = () => window.location.reload();
  const reportCopyError = (err: unknown) =>
    Sentry.captureException(err, { tags: { context: "PaymentWall.copyReference" } });

  // Which card fills the frame, per the view selector. (`view.kind === "content"`
  // already returned above.) The `&& unlockFailure` narrows the type for the
  // card's props and is always true when the view is "unlock_failure".
  const cardContent =
    view.kind === "unlock_failure" && unlockFailure ? (
      <UnlockFailureCard
        orderNumber={unlockFailure.orderNumber}
        orderId={unlockFailure.orderId}
        failedAt={unlockFailure.failedAt}
        merchantName={merchantName}
        onCopyError={reportCopyError}
        onReload={reload}
      />
    ) : view.kind === "verify_failure" ? (
      <VerifyFailureCard
        failedAt={Date.now()}
        merchantName={merchantName}
        onReload={reload}
      />
    ) : view.kind === "buttons" ? (
      <ProductButtons
        products={products}
        loading={loading}
        expiredAccessAt={expiredAccessAt}
        onUnlock={handleUnlock}
        onOpenExchangeGuide={() => setExchangeModalOpen(true)}
      />
    ) : (
      <CheckingAccessPlaceholder />
    );

  // Payment wall
  return (
    <div className="mb-6">
      <PaywallFrame mediaType={mediaType} thumbnailUrl={thumbnailUrl}>
        {cardContent}
      </PaywallFrame>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      {checkoutToken && view.kind !== "unlock_failure" && view.kind !== "verify_failure" && (() => {
        const activeProduct = products.find((p) => p.productId === activeProductId);
        return (
          <CheckoutOverlay
            checkoutToken={checkoutToken}
            merchantLogo={merchantLogo}
            merchantName={merchantName}
            priceCents={activeProduct?.priceCents}
            priceCurrency={activeProduct?.currency}
            onComplete={handleCheckoutComplete}
            onClose={() => setCheckoutToken(null)}
          />
        );
      })()}

      <ExchangeModal
        open={exchangeModalOpen}
        onClose={() => setExchangeModalOpen(false)}
      />
    </div>
  );
}
