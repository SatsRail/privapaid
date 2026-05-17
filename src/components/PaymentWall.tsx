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
import HeartbeatManager from "@/components/HeartbeatManager";
import ExchangeModal from "@/components/ExchangeModal";
import { useLocale } from "@/i18n/useLocale";
import type { TranslatorFn } from "@/i18n";

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

function formatPrice(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function formatDuration(seconds: number, t: TranslatorFn): string {
  if (seconds <= 0) return t("viewer.payment.lifetime");
  if (seconds < 3600) return t("viewer.payment.min", { n: Math.round(seconds / 60) });
  if (seconds < 86400) return t("viewer.payment.hr", { n: Math.round(seconds / 3600) });
  const days = Math.round(seconds / 86400);
  return t("viewer.payment.day", { n: days, count: days });
}

interface PaymentWallProps {
  mediaId: string;
  products: Product[];
  storedProductIds?: string[];
  thumbnailUrl?: string;
  mediaType: string;
  /** For media_type === "photo" only: GridFS ID of the encrypted bytes. */
  photoGridFsId?: string;
  merchantLogo?: string;
  merchantName?: string;
  onRemainingSeconds?: (seconds: number) => void;
  onExpired?: () => void;
}

/** Media types that should show artwork/thumbnail alongside the player */
const ARTWORK_TYPES = new Set(["audio", "podcast"]);

export default function PaymentWall({
  mediaId,
  products,
  storedProductIds,
  thumbnailUrl,
  mediaType,
  photoGridFsId,
  merchantLogo,
  merchantName,
  onRemainingSeconds,
  onExpired,
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
  // Set when the user has a stored macaroon for this media but the mount-time
  // checkAccess can't unlock content (transient verify, network failure, etc).
  // Different from unlockFailure (which only fires on a fresh checkout).
  const [verifyFailure, setVerifyFailure] = useState<{ failedAt: number } | null>(null);
  const [referenceCopied, setReferenceCopied] = useState(false);
  const lastKeyRef = useRef<string | null>(null);

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

  // On mount: only verify products that the server confirmed have stored macaroons
  useEffect(() => {
    async function checkAccess() {
      // 1. Try stored macaroons — only for products the server found in the cookie
      const stored = storedProductIds ?? [];
      const candidateProducts = stored.length > 0
        ? products.filter((p) => stored.includes(p.productId))
        : [];

      // Track whether we saw a TRANSIENT failure signal (502, network, or
      // surprising response shape). On a transient, the user's stored
      // macaroon is likely still valid — show a "couldn't verify" card so
      // they don't think they need to re-pay. Definitive rejections (410)
      // mean the cookie was cleaned server-side; fall through to pay buttons.
      let sawTransient = false;

      for (const product of candidateProducts) {
        try {
          const res = await fetch("/api/macaroons", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ product_id: product.productId }),
          });

          if (!res.ok) {
            if (res.status === 502) sawTransient = true;
            // 410 = definitive rejection — cookie cleaned, fall through to pay buttons
            continue;
          }

          const data = await res.json();

          // Verify key authenticity before decryption
          const fingerprint = data.key_fingerprint || product.keyFingerprint;
          if (!(await verifyKeyFingerprint(data.key, fingerprint))) {
            // Key fingerprint mismatch despite valid macaroon — wrong key
            // delivered or key rotation in progress. Treat as transient.
            sawTransient = true;
            continue;
          }

          // Valid macaroon — decrypt content (photo media also unwraps DEK + fetches bytes)
          const bytes = await resolveContent(product.encryptedBlob, data.key, product.productId);
          lastKeyRef.current = data.key;
          setDecryptedBytes(bytes);
          setActiveProductId(product.productId);
          if (data.remaining_seconds != null) {
            onRemainingSeconds?.(data.remaining_seconds);
          }
          return;
        } catch {
          // Network error inside macaroon flow — treat as transient
          sawTransient = true;
        }
      }

      // 2. Fall back to direct unlock (also macaroon-gated server-side)
      try {
        const unlockRes = await fetch(`/api/media/${mediaId}/unlock`);
        if (unlockRes.ok) {
          const data = await unlockRes.json();
          const product = products.find((p) => p.encryptedBlob === data.encrypted_blob) || products[0];
          if (product) {
            const fingerprint = data.key_fingerprint || product.keyFingerprint;
            if (await verifyKeyFingerprint(data.key, fingerprint)) {
              const bytes = await resolveContent(data.encrypted_blob, data.key, data.product_id);
              lastKeyRef.current = data.key;
              setDecryptedBytes(bytes);
              setActiveProductId(product.productId);
              if (data.remaining_seconds != null) {
                onRemainingSeconds?.(data.remaining_seconds);
              }
              return;
            } else {
              sawTransient = true;
            }
          }
        } else if (unlockRes.status >= 500) {
          sawTransient = true;
        }
      } catch (err) {
        // Direct unlock not available — show payment wall
        Sentry.captureException(err, { tags: { context: "PaymentWall.directUnlock" }, extra: { mediaId } });
        sawTransient = true;
      }

      // Surface a "couldn't verify" card only when there's an actual signal
      // that something transient went wrong. Otherwise pay buttons render
      // as the default — including the case where the cookie was cleaned
      // due to a definitive rejection earlier in this same flow.
      if (sawTransient) {
        setVerifyFailure({ failedAt: Date.now() });
      }
    }

    checkAccess();
  }, [mediaId, products, storedProductIds]);

  // Clear any stale failure state if decryption succeeds via any path
  useEffect(() => {
    if (decryptedBytes) {
      setUnlockFailure(null);
      setVerifyFailure(null);
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
      const recordFailure = () => {
        setUnlockFailure({ orderNumber, orderId, failedAt: Date.now() });
        setError("");
        setCheckoutToken(null);
      };

      // Store macaroon in httpOnly cookie via server — must complete before
      // HeartbeatManager's first tick, otherwise verify finds no cookie and
      // locks content immediately. Skip if the portal returned an empty token.
      if (data.macaroon) {
        try {
          await fetch("/api/macaroons", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              product_id: activeProductId,
              macaroon: data.macaroon,
            }),
          });
          // Notify sibling components (e.g. CommentSection) that access is now available
          window.dispatchEvent(new CustomEvent("privapaid:unlocked"));
        } catch (err) {
          console.error("Failed to store macaroon:", err);
        }
      } else {
        Sentry.captureMessage("Checkout completed with empty macaroon", {
          level: "warning",
          tags: { context: "PaymentWall.checkout" },
          extra: { mediaId, activeProductId, hasKey: !!data.key },
        });
      }

      // Record purchase if customer is logged in
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

      // Verify key authenticity and decrypt content
      const product = products.find((p) => p.productId === activeProductId);
      if (!product) {
        Sentry.captureMessage("Checkout completed but product missing in PaymentWall", {
          level: "error",
          tags: { context: "PaymentWall.missingProduct" },
          extra: { mediaId, activeProductId },
        });
        recordFailure();
        return;
      }

      // If the portal returned a key, try direct decryption
      if (data.key) {
        try {
          if (!(await verifyKeyFingerprint(data.key, product.keyFingerprint))) {
            Sentry.captureMessage("Key fingerprint mismatch after payment", {
              level: "error",
              tags: { context: "PaymentWall.fingerprint" },
              extra: { mediaId, activeProductId },
            });
            recordFailure();
            return;
          }
          const bytes = await resolveContent(product.encryptedBlob, data.key, product.productId);
          lastKeyRef.current = data.key;
          setDecryptedBytes(bytes);
          setCheckoutToken(null);
          // Notify siblings (e.g. CommentSection) even without a stored macaroon
          window.dispatchEvent(new CustomEvent("privapaid:unlocked"));
          return;
        } catch (err) {
          Sentry.captureException(err, { tags: { context: "PaymentWall.decrypt" }, extra: { mediaId, activeProductId } });
        }
      }

      // Fallback: if direct decryption failed or key was empty, try
      // the server-side unlock endpoint (uses stored macaroon from cookie)
      try {
        const unlockRes = await fetch(`/api/media/${mediaId}/unlock`);
        if (unlockRes.ok) {
          const unlockData = await unlockRes.json();
          const fingerprint = unlockData.key_fingerprint || product.keyFingerprint;
          if (await verifyKeyFingerprint(unlockData.key, fingerprint)) {
            const bytes = await resolveContent(unlockData.encrypted_blob, unlockData.key, unlockData.product_id);
            lastKeyRef.current = unlockData.key;
            setDecryptedBytes(bytes);
            setCheckoutToken(null);
            window.dispatchEvent(new CustomEvent("privapaid:unlocked"));
            return;
          }
        }
      } catch (err) {
        Sentry.captureException(err, { tags: { context: "PaymentWall.unlockFallback" }, extra: { mediaId, activeProductId } });
      }

      recordFailure();
    },
    [activeProductId, products, session, mediaId]
  );

  const handleExpired = useCallback(() => {
    lastKeyRef.current = null;
    setDecryptedBytes(null);
    setActiveProductId(null);
    onExpired?.();
  }, [onExpired]);

  const handleKeyRefreshed = useCallback(
    async (key: string) => {
      // Skip re-decryption if key hasn't changed — prevents iframe/video restart
      if (key === lastKeyRef.current) return;

      if (!activeProductId) return;
      const product = products.find((p) => p.productId === activeProductId);
      if (!product) return;

      try {
        if (!(await verifyKeyFingerprint(key, product.keyFingerprint))) return;
        const bytes = await resolveContent(product.encryptedBlob, key, product.productId);
        lastKeyRef.current = key;
        setDecryptedBytes(bytes);
      } catch {
        // Key might have changed — content will re-render next heartbeat
      }
    },
    [activeProductId, products]
  );

  const handleRemainingSeconds = useCallback((seconds: number) => {
    onRemainingSeconds?.(seconds);
  }, [onRemainingSeconds]);

  // Content is unlocked
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
        {activeProductId && (
          <HeartbeatManager
            productId={activeProductId}
            onExpired={handleExpired}
            onKeyRefreshed={handleKeyRefreshed}
            onRemainingSeconds={handleRemainingSeconds}
          />
        )}
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

  const referenceText = unlockFailure
    ? [unlockFailure.orderNumber, unlockFailure.orderId].filter(Boolean).join(" / ")
    : "";

  async function handleCopyReference() {
    if (!referenceText) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(referenceText);
      } else {
        // Fallback for older browsers / non-secure contexts: select via a temporary element
        const ta = document.createElement("textarea");
        ta.value = referenceText;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand?.("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("execCommand copy failed");
      }
      setReferenceCopied(true);
      setTimeout(() => setReferenceCopied(false), 2000);
    } catch (err) {
      Sentry.captureException(err, { tags: { context: "PaymentWall.copyReference" } });
      // Show a brief error inline using the existing error string slot
      setError(t("viewer.payment.unlock_failed.copy_failed"));
      setTimeout(() => setError(""), 2500);
    }
  }

  function handleReload() {
    window.location.reload();
  }

  const errorCard = unlockFailure ? (
    <div className="flex w-full max-w-md flex-col items-center gap-4 px-2 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>

      <div className="flex flex-col items-center gap-1">
        <h3 className="text-lg font-semibold text-white">
          {t("viewer.payment.unlock_failed.title")}
        </h3>
        <p className="text-sm text-zinc-300">
          {t("viewer.payment.unlock_failed.body")}
        </p>
      </div>

      <div className="w-full rounded-lg border border-zinc-700 bg-zinc-800/60 p-3 text-left">
        <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-400">
          <span>{t("viewer.payment.unlock_failed.timestamp_label")}</span>
          <span className="font-mono text-[11px] tabular-nums text-zinc-300 normal-case">
            {new Date(unlockFailure.failedAt).toLocaleString(locale)}
          </span>
        </div>
        <div className="text-xs uppercase tracking-wide text-zinc-400">
          {t("viewer.payment.unlock_failed.reference_label")}
        </div>
        <div className="mt-1 break-all font-mono text-sm text-amber-300">
          {unlockFailure.orderNumber || unlockFailure.orderId || t("viewer.payment.unlock_failed.no_reference")}
        </div>
        {unlockFailure.orderNumber && unlockFailure.orderId && (
          <div className="mt-1 break-all font-mono text-[11px] text-zinc-500">
            {unlockFailure.orderId}
          </div>
        )}
      </div>

      <p className="text-sm text-zinc-300">
        {merchantName
          ? t("viewer.payment.unlock_failed.contact", { merchant: merchantName })
          : t("viewer.payment.unlock_failed.contact_generic")}
      </p>

      <div className="flex w-full flex-col gap-2 sm:flex-row">
        {referenceText && (
          <button
            onClick={handleCopyReference}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800"
          >
            {referenceCopied
              ? t("viewer.payment.unlock_failed.copied")
              : t("viewer.payment.unlock_failed.copy_reference")}
          </button>
        )}
        <button
          onClick={handleReload}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--theme-primary)] px-3 py-2 text-sm font-semibold text-black transition-colors"
        >
          {t("viewer.payment.unlock_failed.reload")}
        </button>
      </div>
    </div>
  ) : null;

  const verifyCard = verifyFailure ? (
    <div className="flex w-full max-w-md flex-col items-center gap-4 px-2 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>

      <div className="flex flex-col items-center gap-1">
        <h3 className="text-lg font-semibold text-white">
          {t("viewer.payment.verify_failed.title")}
        </h3>
        <p className="text-sm text-zinc-300">
          {t("viewer.payment.verify_failed.body")}
        </p>
      </div>

      <div className="w-full rounded-lg border border-zinc-700 bg-zinc-800/60 p-3 text-left">
        <div className="flex items-center justify-between text-xs uppercase tracking-wide text-zinc-400">
          <span>{t("viewer.payment.unlock_failed.timestamp_label")}</span>
          <span className="font-mono text-[11px] tabular-nums text-zinc-300 normal-case">
            {new Date(verifyFailure.failedAt).toLocaleString(locale)}
          </span>
        </div>
      </div>

      <p className="text-sm text-zinc-300">
        {merchantName
          ? t("viewer.payment.unlock_failed.contact", { merchant: merchantName })
          : t("viewer.payment.unlock_failed.contact_generic")}
      </p>

      <button
        onClick={handleReload}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--theme-primary)] px-3 py-2 text-sm font-semibold text-black transition-colors"
      >
        {t("viewer.payment.unlock_failed.reload")}
      </button>
    </div>
  ) : null;

  const cardContent = unlockFailure ? errorCard : verifyFailure ? verifyCard : productButtons;

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

      {checkoutToken && !unlockFailure && !verifyFailure && (() => {
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
