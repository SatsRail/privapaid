"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
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
import { useLocale } from "@/i18n/useLocale";
import { formatPrice, formatDuration } from "@/lib/format";
import type { MediaAccess } from "@/lib/use-media-access";

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
  /** For media_type === "photo" only: GridFS ID of the encrypted bytes. */
  photoGridFsId?: string;
  merchantLogo?: string;
  merchantName?: string;
}

/** Media types that should show artwork/thumbnail alongside the player */
const ARTWORK_TYPES = new Set(["audio", "podcast"]);

export default function PaymentWall({
  mediaId,
  products,
  access,
  onAccessClaim,
  thumbnailUrl,
  mediaType,
  photoGridFsId,
  merchantLogo,
  merchantName,
}: PaymentWallProps) {
  const { data: session } = useSession();
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
  // Soft-fail card for transient portal hiccups. Distinct from `unlockFailure`,
  // which is for "you just paid and decryption failed."
  const showVerifyFailure =
    access.status === "inactive" && access.reason === "transient";

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

  // Unwrap encrypted content into displayable bytes. For non-photo media this
  // is a single AES-GCM decrypt. For photo media the encrypted blob holds a
  // DEK (envelope encryption): unwrap the DEK with the product key, fetch
  // the ciphertext from GridFS, then decrypt with the DEK.
  const resolveContent = useCallback(
    async (encryptedBlob: string, key: string, productId: string): Promise<Uint8Array> => {
      const inner = await decryptBlob(encryptedBlob, key, productId);
      if (mediaType !== "photo") return inner;
      if (!photoGridFsId) {
        throw new Error("Photo media is missing its GridFS pointer");
      }
      // `inner` is the UTF-8 bytes of the base64url DEK; decode it back to 32 raw bytes.
      const dekBase64url = new TextDecoder().decode(inner);
      const dekBytes = base64urlToBytes(dekBase64url);
      const res = await fetch(`/api/photos/${photoGridFsId}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch encrypted photo: ${res.status}`);
      }
      const ciphertext = new Uint8Array(await res.arrayBuffer());
      return decryptBytesWithKey(ciphertext, dekBytes);
    },
    [mediaType, photoGridFsId]
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

      if (session?.user?.role === "customer") {
        fetch("/api/customer/purchases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order_id: "from_checkout",
            product_id: activeProductId,
          }),
        }).catch((err) => console.error("Failed to record purchase:", err));
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
    [activeProductId, products, session, mediaId, reportException, reportMessage, onAccessClaim]
  );

  if (decryptedBytes) {
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

  const productButtons = (
    <div className="flex flex-col items-center gap-3 w-full max-w-sm">
      <div className="flex items-center gap-2 mb-1">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-[#f7931a]">
          <path d="M23.638 14.904c-1.602 6.43-8.113 10.34-14.542 8.736C2.67 22.05-1.244 15.525.362 9.105 1.962 2.67 8.475-1.243 14.9.358c6.43 1.605 10.342 8.115 8.738 14.546z" />
          <path d="M17.204 10.676c.242-1.626-1.006-2.502-2.716-3.083l.555-2.22-1.356-.338-.54 2.16c-.356-.09-.722-.174-1.088-.258l.544-2.174-1.354-.338-.555 2.218c-.295-.067-.584-.133-.864-.203l.002-.007-1.87-.467-.36 1.448s1.006.23.985.245c.55.137.649.5.633.788l-.634 2.536c.038.01.087.024.141.045l-.143-.036-.888 3.556c-.067.167-.237.417-.622.322.014.02-.986-.246-.986-.246l-.674 1.553 1.764.44c.328.082.65.168.966.249l-.56 2.248 1.354.338.556-2.222c.37.1.728.192 1.08.279l-.554 2.213 1.356.338.56-2.244c2.3.433 4.03.258 4.757-1.812.585-1.667-.03-2.628-1.244-3.257.885-.204 1.55-.785 1.728-1.985zm-3.094 4.325c-.416 1.667-3.23.766-4.142.54l.74-2.958c.912.228 3.836.678 3.402 2.418zm.416-4.35c-.38 1.516-2.724.746-3.484.557l.67-2.683c.76.19 3.21.543 2.814 2.126z" fill="white" />
        </svg>
        <span className="text-lg font-semibold">{t("viewer.payment.unlock_with_bitcoin")}</span>
      </div>
      {products.map((product) => (
        <button
          key={product.productId}
          onClick={() => handleUnlock(product.productId)}
          disabled={loading}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800/80 px-4 py-3 text-left transition-colors hover:border-[var(--theme-primary)] hover:bg-zinc-800 disabled:opacity-50"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm text-white">
              {product.name || t("viewer.payment.unlock_content")}
            </span>
            {product.priceCents != null && (
              <span className="font-semibold text-[var(--theme-primary)]">
                {formatPrice(product.priceCents, product.currency || "USD", locale)}
              </span>
            )}
          </div>
          {product.accessDurationSeconds != null && (
            <span className="text-xs text-zinc-400">
              {t("viewer.payment.duration_access", { duration: formatDuration(product.accessDurationSeconds, t) })}
            </span>
          )}
        </button>
      ))}
      <button
        onClick={() => setExchangeModalOpen(true)}
        className="mt-1 text-sm font-medium text-zinc-300 underline underline-offset-2 hover:text-[var(--theme-primary)]"
      >
        {t("viewer.exchange_guide.need_bitcoin")}
      </button>
    </div>
  );

  const reload = () => window.location.reload();
  const reportCopyError = (err: unknown) =>
    Sentry.captureException(err, { tags: { context: "PaymentWall.copyReference" } });

  const cardContent = unlockFailure ? (
    <UnlockFailureCard
      orderNumber={unlockFailure.orderNumber}
      orderId={unlockFailure.orderId}
      failedAt={unlockFailure.failedAt}
      merchantName={merchantName}
      onCopyError={reportCopyError}
      onReload={reload}
    />
  ) : showVerifyFailure ? (
    <VerifyFailureCard
      failedAt={Date.now()}
      merchantName={merchantName}
      onReload={reload}
    />
  ) : productButtons;

  // Payment wall
  return (
    <div className="mb-6">
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        {mediaType === "photo" ? (
          // Single photo: black canvas with centered buttons
          <div className="flex flex-col items-center justify-center bg-black px-4 py-12 min-h-[320px]">
            {cardContent}
          </div>
        ) : (
          <>
            {thumbnailUrl ? (
              <div className="relative flex min-h-[320px] flex-col items-center justify-center px-4">
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
              <div className="flex flex-col items-center px-4 py-6">
                {cardContent}
              </div>
            )}
          </>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      {checkoutToken && !unlockFailure && !showVerifyFailure && (() => {
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
