"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import * as Sentry from "@sentry/nextjs";
import { useLocale } from "@/i18n/useLocale";
import { useDialog } from "@/components/ui/useDialog";

interface CheckoutOverlayProps {
  checkoutToken: string;
  merchantLogo?: string;
  merchantName?: string;
  priceCents?: number;
  priceCurrency?: string;
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
  onComplete,
  onClose,
}: CheckoutOverlayProps) {
  const { t, locale } = useLocale();
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [paymentRequest, setPaymentRequest] = useState<string | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [amountSats, setAmountSats] = useState<number | null>(null);
  const [amountCents, setAmountCents] = useState<number | null>(priceCents ?? null);
  const [currency, setCurrency] = useState<string | null>(priceCurrency ?? null);
  const [status, setStatus] = useState<"pending" | "expired" | "error">("pending");
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
        setStatus("pending");
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
    navigator.clipboard.writeText(paymentRequest).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm" style={{ backgroundColor: "rgba(0,0,0,0.5)" }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("viewer.checkout.title")}
        tabIndex={-1}
        className="relative w-full max-w-sm rounded-2xl border p-6 outline-none"
        style={{
          backgroundColor: "var(--theme-bg)",
          borderColor: "var(--theme-border)",
        }}
      >

        {status === "error" && (
          <div className="flex flex-col items-center py-12">
            <p className="text-sm text-red-400">{t("viewer.checkout.load_error")}</p>
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
          <div className="flex flex-col items-center py-12">
            <p className="text-sm text-yellow-400">{t("viewer.checkout.expired")}</p>
            <button
              onClick={handleClose}
              className="mt-4 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
              style={{ backgroundColor: "var(--theme-bg-secondary)", color: "var(--theme-text)" }}
            >
              {t("viewer.checkout.close")}
            </button>
          </div>
        )}

        {status === "pending" && (
          <div className="flex flex-col items-center">
            {/* Merchant logo */}
            {merchantLogo ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={merchantLogo}
                alt={merchantName || ""}
                className="mb-4 h-12 w-12 rounded-full object-cover"
              />
            ) : (
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full" style={{ backgroundColor: "color-mix(in srgb, var(--theme-primary) 15%, transparent)" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--theme-primary)" }}>
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </div>
            )}

            {/* Price — fiat large, sats below in theme primary */}
            {amountCents != null && currency ? (
              <div className="mb-4 text-center">
                <p className="text-3xl font-bold tabular-nums" style={{ color: "var(--theme-heading)" }}>
                  {formatFiat(amountCents, currency, locale)}
                </p>
                {amountSats != null && (
                  <p className="mt-1 text-sm font-medium tabular-nums" style={{ color: "var(--theme-primary)" }}>
                    {amountSats.toLocaleString()} sats
                  </p>
                )}
              </div>
            ) : amountSats != null ? (
              <div className="mb-4 text-center">
                <p className="text-3xl font-bold tabular-nums" style={{ color: "var(--theme-heading)" }}>
                  {amountSats.toLocaleString()} <span className="text-lg" style={{ color: "var(--theme-text-secondary)" }}>sats</span>
                </p>
              </div>
            ) : null}

            {/* QR Code — rendered via an <img> data URI, never injected as
                markup: SVG in an <img> can't run scripts or load external
                resources, so even a compromised QR endpoint can't XSS here. */}
            {qrSvg ? (
              <div className="rounded-xl bg-white p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/svg+xml,${encodeURIComponent(qrSvg)}`}
                  alt={t("viewer.checkout.title")}
                  className="h-[250px] w-[250px]"
                />
              </div>
            ) : (
              <div className="flex h-[250px] w-[250px] items-center justify-center rounded-xl" style={{ backgroundColor: "var(--theme-bg-secondary)" }}>
                <div className="h-6 w-6 animate-spin rounded-full border-2" style={{ borderColor: "var(--theme-border)", borderTopColor: "var(--theme-primary)" }} />
              </div>
            )}

            {/* Timer + waiting status */}
            <div className="mt-4 flex flex-col items-center gap-1">
              {timeRemaining != null && timeRemaining > 0 && (
                <p className="flex items-center gap-1.5 text-sm tabular-nums" style={{ color: "var(--theme-text-secondary)" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  {formatTime(timeRemaining)}
                </p>
              )}
              <p className="flex items-center gap-1.5 text-sm" style={{ color: "var(--theme-text-secondary)" }}>
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "var(--theme-primary)" }} />
                {t("viewer.checkout.waiting")}
              </p>
            </div>

            {/* Copy Invoice + Open Wallet */}
            {paymentRequest && (
              <div className="mt-4 flex w-full gap-2">
                <button
                  onClick={handleCopy}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border py-2.5 text-sm font-medium transition-colors"
                  style={{ borderColor: "var(--theme-border)", color: "var(--theme-text)" }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  {copied ? t("viewer.checkout.copied") : t("viewer.checkout.copy_invoice")}
                </button>
                <a
                  href={`lightning:${paymentRequest}`}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-medium text-black transition-colors"
                  style={{ backgroundColor: "var(--theme-primary)" }}
                >
                  {t("viewer.checkout.open_wallet")}
                </a>
              </div>
            )}

            {/* Cancel */}
            <button
              onClick={handleClose}
              className="mt-4 text-sm transition-colors"
              style={{ color: "var(--theme-text-secondary)" }}
            >
              {t("viewer.checkout.cancel")}
            </button>

            {/* Powered by */}
            <a
              href="https://www.satsrail.com"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 text-xs transition-colors hover:underline"
              style={{ color: "var(--theme-text-secondary)", opacity: 0.6 }}
            >
              powered by SatsRail.com
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
