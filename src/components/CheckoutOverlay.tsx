"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import * as Sentry from "@sentry/nextjs";
import { useLocale } from "@/i18n/useLocale";
import { useDialog } from "@/components/ui/useDialog";
import { formatDuration } from "@/lib/format";

interface CheckoutOverlayProps {
  checkoutToken: string;
  merchantLogo?: string;
  merchantName?: string;
  priceCents?: number;
  priceCurrency?: string;
  productName?: string;
  accessDurationSeconds?: number;
  onComplete: (data: {
    key: string;
    macaroon: string;
    remaining_seconds: number;
    order_number: string | null;
    order_id: string | null;
  }) => void;
  onClose: () => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatFiat(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export default function CheckoutOverlay({
  checkoutToken,
  merchantLogo,
  merchantName,
  priceCents,
  priceCurrency,
  productName,
  accessDurationSeconds,
  onComplete,
  onClose,
}: CheckoutOverlayProps) {
  const { t, locale } = useLocale();
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [qrLoaded, setQrLoaded] = useState(false);
  const [paymentRequest, setPaymentRequest] = useState<string | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [amountSats, setAmountSats] = useState<number | null>(null);
  const [amountCents, setAmountCents] = useState<number | null>(priceCents ?? null);
  const [currency, setCurrency] = useState<string | null>(priceCurrency ?? null);
  const [status, setStatus] = useState<"pending" | "expired" | "error">("pending");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // QR and status arrive independently. Reveal the invoice together so adding
  // its amount, timer, and wallet actions cannot move an already-visible QR.
  const invoiceReady = qrLoaded && !!paymentRequest && amountSats != null && timeRemaining != null;

  const cleanup = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const handleClose = useCallback(() => {
    cleanup();
    onClose();
  }, [cleanup, onClose]);

  // Dialog a11y (focus trap, scroll lock, Escape-to-close, focus restore).
  // The overlay is only mounted while active, so it is always "open".
  const dialogRef = useDialog({ open: true, onClose: handleClose });

  // Fetch QR code on mount
  useEffect(() => {
    fetch(`/api/checkout/${checkoutToken}/qr`)
      .then((res) => {
        if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
        return res.text();
      })
      .then(setQrSvg)
      .catch((err) => {
        Sentry.captureException(err, { tags: { context: "CheckoutOverlay.qr" } });
        setStatus("error");
      });
  }, [checkoutToken]);

  // Poll status every 3s
  useEffect(() => {
    async function checkStatus() {
      try {
        const res = await fetch(`/api/checkout/${checkoutToken}/status`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.status === "completed") {
          cleanup();
          const key = data.items?.[0]?.key ?? "";
          const macaroon = data.access_token ?? "";
          // ALWAYS log on completion (not just when missing) so we can see
          // what the portal actually returned for a given order — needed
          // to disambiguate "portal sent empty key" from "client dropped key"
          // for the article failure mode.
          Sentry.captureMessage("CheckoutOverlay.completed", {
            level: !key || !macaroon ? "warning" : "info",
            tags: { context: "CheckoutOverlay.completed" },
            extra: {
              hasKey: !!key,
              hasMacaroon: !!macaroon,
              hasItems: !!data.items,
              itemCount: data.items?.length ?? 0,
              keyLength: key.length,
              macaroonLength: macaroon.length,
              orderId: data.order_id ?? null,
              orderNumber: data.order_number ?? null,
              accessDurationSeconds: data.access_duration_seconds ?? null,
            },
          });
          onComplete({
            key,
            macaroon,
            remaining_seconds: data.access_duration_seconds ?? 0,
            order_number: data.order_number ?? null,
            order_id: data.order_id ?? null,
          });
          return;
        }

        if (data.status === "expired") {
          cleanup();
          setStatus("expired");
          return;
        }

        // Pending
        if (data.payment_request && !paymentRequest) {
          setPaymentRequest(data.payment_request);
        }
        if (data.time_remaining != null) {
          setTimeRemaining(Math.floor(data.time_remaining));
        }
        if (data.amount_sats != null) setAmountSats(data.amount_sats);
        if (data.amount_cents != null) setAmountCents(data.amount_cents);
        if (data.currency) setCurrency(data.currency);
        // A pending session does not mean the QR loaded successfully.
        // Keep a QR error visible instead of reverting to an endless spinner.
      } catch {
        // Ignore transient poll errors
      }
    }

    checkStatus();
    pollRef.current = setInterval(checkStatus, 3000);
    return cleanup;
  }, [checkoutToken, cleanup, onComplete, paymentRequest]);

  // Countdown timer
  useEffect(() => {
    if (timeRemaining == null || timeRemaining <= 0) return;

    timerRef.current = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev == null || prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [timeRemaining != null]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleCopy() {
    if (!paymentRequest) return;
    setCopyFailed(false);
    Promise.resolve().then(() => navigator.clipboard.writeText(paymentRequest))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopyFailed(true));
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 backdrop-blur-sm sm:p-6" style={{ backgroundColor: "var(--theme-backdrop)" }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("viewer.checkout.title")}
        tabIndex={-1}
        className="relative max-h-[calc(100dvh-1.5rem)] w-full max-w-sm overflow-y-auto overscroll-contain rounded-2xl border p-5 shadow-2xl outline-none sm:p-6"
        style={{
          backgroundColor: "var(--theme-bg)",
          borderColor: "var(--theme-border)",
        }}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{t("viewer.checkout.title")}</h2>
          <button onClick={handleClose} aria-label={t("viewer.checkout.close")}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-[var(--theme-bg-secondary)]"
            style={{ color: "var(--theme-text-secondary)" }}>
            <svg aria-hidden="true" width="20" height="20" fill="currentColor" viewBox="0 0 16 16">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708" />
            </svg>
          </button>
        </div>

        {status === "error" && (
          <div role="alert" className="flex flex-col items-center py-8 text-center">
            <p className="text-sm text-[var(--theme-error)]">{t("viewer.checkout.load_error")}</p>
            <p className="mt-3 text-sm" style={{ color: "var(--theme-text-secondary)" }}>{t("viewer.checkout.error_help")}</p>
            <button
              onClick={handleClose}
              className="mt-4 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
              style={{ backgroundColor: "var(--theme-bg-secondary)", color: "var(--theme-text)" }}
            >
              {t("viewer.checkout.close")}
            </button>
          </div>
        )}

        {status === "expired" && (
          <div role="alert" className="flex flex-col items-center py-8 text-center">
            <p className="text-sm text-[var(--theme-warning)]">{t("viewer.checkout.expired")}</p>
            <p className="mt-3 text-sm" style={{ color: "var(--theme-text-secondary)" }}>{t("viewer.checkout.expired_help")}</p>
            <button
              onClick={handleClose}
              className="mt-4 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
              style={{ backgroundColor: "var(--theme-bg-secondary)", color: "var(--theme-text)" }}
            >
              {t("viewer.checkout.close")}
            </button>
          </div>
        )}

        {status === "pending" && !invoiceReady && (
          <div role="status" className="flex flex-col items-center justify-center gap-3 py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2" style={{ borderColor: "var(--theme-border)", borderTopColor: "var(--theme-primary)" }} />
            <p className="text-sm" style={{ color: "var(--theme-text-secondary)" }}>{t("viewer.checkout.preparing")}</p>
          </div>
        )}

        {status === "pending" && (
          <div className="flex flex-col items-center" hidden={!invoiceReady} style={invoiceReady ? undefined : { display: "none" }}>
            {/* Merchant logo */}
            {merchantLogo && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={merchantLogo}
                alt={merchantName || ""}
                className="mb-2 h-8 w-8 rounded-full object-cover"
              />
            )}

            <div className="mb-4 flex w-full items-center justify-between gap-4 border-b pb-4" style={{ borderColor: "var(--theme-border)" }}>
              <div className="min-w-0 flex-1">
                {merchantName && <p className="mb-1 text-sm" style={{ color: "var(--theme-text-secondary)" }}>{merchantName}</p>}
                {productName && <p className="mb-1 break-words text-base font-medium">{productName}</p>}
                {accessDurationSeconds != null && (
                  <p className="text-xs" style={{ color: "var(--theme-text-secondary)" }}>
                    {t("viewer.payment.duration_access", { duration: formatDuration(accessDurationSeconds, t) })}
                  </p>
                )}
              </div>

              {/* Price — fiat large, sats below in theme primary */}
              {amountCents != null && currency ? (
                <div className="shrink-0 text-right">
                  <p className="text-3xl font-bold tabular-nums" style={{ color: "var(--theme-heading)" }}>
                    {formatFiat(amountCents, currency, locale)}
                  </p>
                  {amountSats != null && (
                    <p className="mt-1 text-sm font-medium tabular-nums" style={{ color: "var(--theme-link)" }}>
                      {amountSats.toLocaleString(locale)} sats
                    </p>
                  )}
                </div>
              ) : amountSats != null ? (
                <div className="shrink-0 text-right">
                  <p className="text-3xl font-bold tabular-nums" style={{ color: "var(--theme-heading)" }}>
                    {amountSats.toLocaleString(locale)} <span className="text-lg" style={{ color: "var(--theme-text-secondary)" }}>sats</span>
                  </p>
                </div>
              ) : null}
            </div>

            {/* QR Code — rendered via an <img> data URI, never injected as
                markup: SVG in an <img> can't run scripts or load external
                resources, so even a compromised QR endpoint can't XSS here. */}
            {qrSvg && (
              <div className="w-full max-w-[282px] rounded-xl bg-white p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/svg+xml,${encodeURIComponent(qrSvg)}`}
                  alt={t("viewer.checkout.title")}
                  className="aspect-square h-auto w-full"
                  onLoad={() => setQrLoaded(true)}
                  onError={() => setStatus("error")}
                />
              </div>
            )}

            <p className="mt-3 text-center text-sm leading-relaxed" style={{ color: "var(--theme-text-secondary)" }}>
              {t("viewer.checkout.instructions")}
            </p>

            {/* Timer + waiting status */}
            <div className="mt-4 flex w-full flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ backgroundColor: "var(--theme-bg-secondary)" }}>
              {timeRemaining != null && timeRemaining > 0 && (
                <p className="flex items-center gap-1.5 text-sm tabular-nums" style={{ color: "var(--theme-text-secondary)" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  {t("viewer.checkout.expires_in", { time: formatTime(timeRemaining) })}
                </p>
              )}
              <p role="status" className="flex items-center gap-1.5 text-xs" style={{ color: "var(--theme-text-secondary)" }}>
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "var(--theme-primary)" }} />
                {t("viewer.checkout.waiting")}
              </p>
            </div>

            {/* Copy Invoice + Open Wallet */}
            {paymentRequest && (
              <div className="mt-4 flex w-full flex-col gap-2">
                <a
                  href={`lightning:${paymentRequest}`}
                  className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-semibold text-[var(--theme-primary-text)] transition-opacity hover:opacity-90"
                  style={{ backgroundColor: "var(--theme-primary)" }}
                >
                  {t("viewer.checkout.open_wallet")}
                </a>
                <button
                  onClick={handleCopy}
                  className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--theme-bg-secondary)]"
                  style={{ borderColor: "var(--theme-border)", color: "var(--theme-text)" }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  {copied ? t("viewer.checkout.copied") : t("viewer.checkout.copy_invoice")}
                </button>
              </div>
            )}

            {copyFailed && <p role="alert" className="mt-2 text-center text-sm text-[var(--theme-error)]">{t("viewer.checkout.copy_failed")}</p>}
            <p className="mt-3 text-center text-xs leading-relaxed" style={{ color: "var(--theme-text-secondary)" }}>{t("viewer.checkout.unlock_hint")}</p>

            {/* Cancel */}
            <button
              onClick={handleClose}
              className="mt-2 min-h-11 px-4 text-sm transition-colors hover:underline"
              style={{ color: "var(--theme-text-secondary)" }}
            >
              {t("viewer.checkout.cancel")}
            </button>

            {/* Powered by */}
            <a
              href="https://www.satsrail.com"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 text-xs transition-colors hover:underline"
              style={{ color: "var(--theme-text-secondary)" }}
            >
              powered by SatsRail.com
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
