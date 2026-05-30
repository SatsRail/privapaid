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
import ExpiredAccessBanner from "@/components/ExpiredAccessBanner";
import UnlockFailureCard from "@/components/UnlockFailureCard";
import VerifyFailureCard from "@/components/VerifyFailureCard";
import { useLocale } from "@/i18n/useLocale";
import { formatPrice, formatDuration } from "@/lib/format";
import type { MediaAccess } from "@/lib/use-media-access";
import { resolvePaywallView } from "@/lib/paywall-view";

interface Product {
  productId: string;
  encryptedBlob: string;
  keyFingerprint?: string;
  name?: string;
  priceCents?: number;
  currency?: string;
  accessDurationSeconds?: number;
  status?: string;
}

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
  const { t, locale } = useLocale();
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
    [activeProductId, products, mediaId, reportException, reportMessage, reportDecryptError, onAccessClaim]
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

  const productButtons = (
    <div className="flex w-full max-w-sm flex-col items-center gap-3">
      {expiredAccessAt && <ExpiredAccessBanner expiredAt={expiredAccessAt} />}
      <div className="mb-2 flex flex-col items-center gap-2">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-[#f7931a]/30 blur-xl" aria-hidden="true" />
          <div className="relative flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-[#ffb547] to-[#f7931a] shadow-[0_8px_24px_-8px_rgba(247,147,26,0.6)] ring-1 ring-inset ring-white/20">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="text-white">
              <path d="M17.204 10.676c.242-1.626-1.006-2.502-2.716-3.083l.555-2.22-1.356-.338-.54 2.16c-.356-.09-.722-.174-1.088-.258l.544-2.174-1.354-.338-.555 2.218c-.295-.067-.584-.133-.864-.203l.002-.007-1.87-.467-.36 1.448s1.006.23.985.245c.55.137.649.5.633.788l-.634 2.536c.038.01.087.024.141.045l-.143-.036-.888 3.556c-.067.167-.237.417-.622.322.014.02-.986-.246-.986-.246l-.674 1.553 1.764.44c.328.082.65.168.966.249l-.56 2.248 1.354.338.556-2.222c.37.1.728.192 1.08.279l-.554 2.213 1.356.338.56-2.244c2.3.433 4.03.258 4.757-1.812.585-1.667-.03-2.628-1.244-3.257.885-.204 1.55-.785 1.728-1.985zm-3.094 4.325c-.416 1.667-3.23.766-4.142.54l.74-2.958c.912.228 3.836.678 3.402 2.418zm.416-4.35c-.38 1.516-2.724.746-3.484.557l.67-2.683c.76.19 3.21.543 2.814 2.126z" />
            </svg>
          </div>
        </div>
        <span className="text-xl font-semibold tracking-tight text-white">
          {t("viewer.payment.unlock_with_bitcoin")}
        </span>
      </div>
      <div className="flex w-full flex-col gap-2.5">
        {products.map((product) => (
          <button
            key={product.productId}
            onClick={() => handleUnlock(product.productId)}
            disabled={loading}
            className="group relative w-full overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-zinc-800/90 via-zinc-900/90 to-zinc-950/90 px-4 py-3.5 text-left shadow-[0_4px_16px_-6px_rgba(0,0,0,0.5)] ring-1 ring-inset ring-white/5 transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--theme-primary)]/50 hover:shadow-[0_8px_28px_-8px_var(--theme-primary)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold tracking-tight text-white">
                  {product.name || t("viewer.payment.unlock_content")}
                </span>
                {product.accessDurationSeconds != null && (
                  <span className="mt-1 inline-flex items-center gap-1.5 text-xs text-zinc-400">
                    <svg
                      aria-hidden="true"
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v5l3 2" />
                    </svg>
                    {t("viewer.payment.duration_access", { duration: formatDuration(product.accessDurationSeconds, t) })}
                  </span>
                )}
              </div>
              {product.priceCents != null && (
                <span className="shrink-0 text-lg font-semibold tabular-nums tracking-tight text-[var(--theme-primary)] transition-transform duration-200 group-hover:scale-105">
                  {formatPrice(product.priceCents, product.currency || "USD", locale)}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
      <button
        onClick={() => setExchangeModalOpen(true)}
        className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-300 transition-colors hover:text-[var(--theme-primary)]"
      >
        <span className="underline underline-offset-4 decoration-zinc-500/50 group-hover:decoration-[var(--theme-primary)]">
          {t("viewer.exchange_guide.need_bitcoin")}
        </span>
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-transform duration-200 group-hover:translate-x-0.5"
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  );

  // Access-first placeholder. Shown while the hook is still verifying
  // (`loading`) and during the brief `active`-but-still-decrypting window —
  // both states sit past the `decryptedBytes` early return above. Honors the
  // hook's documented "loading → render nothing (yet)" contract so a returning
  // paid viewer never sees the buy buttons flash before content appears. The
  // surrounding frame keeps min-h-[440px] + the blurred preview, so swapping
  // this in for the buttons causes no layout shift.
  const checkingPlaceholder = (
    <div
      role="status"
      data-testid="checking-access"
      className="flex w-full max-w-sm flex-col items-center justify-center gap-3 py-4"
    >
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-[var(--theme-primary)]"
        aria-hidden="true"
      />
      <span className="text-sm font-medium text-zinc-300">
        {t("viewer.payment.checking_access")}
      </span>
    </div>
  );

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
      productButtons
    ) : (
      checkingPlaceholder
    );

  // Payment wall
  return (
    <div className="mb-6">
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        {mediaType === "photo" ? (
          // Single photo: black canvas with centered buttons
          <div className="flex min-h-[440px] flex-col items-center justify-center bg-black px-4 pt-20 pb-16">
            {cardContent}
          </div>
        ) : (
          <>
            {thumbnailUrl ? (
              <div className="relative flex min-h-[440px] flex-col items-center justify-center px-4 pt-20 pb-16">
                <img
                  src={thumbnailUrl}
                  alt="Preview"
                  className="absolute inset-0 h-full w-full object-cover opacity-40 blur-sm"
                />
                <div className="absolute inset-0 bg-black/40" />
                <div className="relative z-10">
                  {cardContent}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center px-4 pt-20 pb-16">
                {cardContent}
              </div>
            )}
          </>
        )}
      </div>

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
