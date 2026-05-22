"use client";

import { useState } from "react";
import { useLocale } from "@/i18n/useLocale";
import AlertIcon from "@/components/icons/AlertIcon";

interface UnlockFailureCardProps {
  /** Lightning order number (ORD-...). */
  orderNumber: string | null;
  /** Internal order UUID. */
  orderId: string | null;
  /** When the unlock attempt failed (ms epoch). */
  failedAt: number;
  /** Merchant name for the contact line — falls back to a generic message. */
  merchantName?: string;
  /** Called after a clipboard copy throws — typically `Sentry.captureException`. */
  onCopyError?: (err: unknown) => void;
  /** Called when the user clicks "Reload page". */
  onReload: () => void;
}

/**
 * Shown to a customer whose Lightning payment succeeded but whose content
 * could not be decrypted on this device. Surfaces the order reference so
 * the customer can hand it to the merchant for manual recovery.
 */
export default function UnlockFailureCard({
  orderNumber,
  orderId,
  failedAt,
  merchantName,
  onCopyError,
  onReload,
}: UnlockFailureCardProps) {
  const { t, locale } = useLocale();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");

  const reference = [orderNumber, orderId].filter(Boolean).join(" / ");

  async function handleCopy() {
    if (!reference) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(reference);
      } else {
        // Fallback for non-secure contexts: select via a temporary element.
        const ta = document.createElement("textarea");
        ta.value = reference;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand?.("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("execCommand copy failed");
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      onCopyError?.(err);
      setCopyError(t("viewer.payment.unlock_failed.copy_failed"));
      setTimeout(() => setCopyError(""), 2500);
    }
  }

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4 px-2 text-center">
      <AlertIcon variant="triangle" />

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
            {new Date(failedAt).toLocaleString(locale)}
          </span>
        </div>
        <div className="text-xs uppercase tracking-wide text-zinc-400">
          {t("viewer.payment.unlock_failed.reference_label")}
        </div>
        <div className="mt-1 break-all font-mono text-sm text-amber-300">
          {orderNumber || orderId || t("viewer.payment.unlock_failed.no_reference")}
        </div>
        {orderNumber && orderId && (
          <div className="mt-1 break-all font-mono text-[11px] text-zinc-500">
            {orderId}
          </div>
        )}
      </div>

      <p className="text-sm text-zinc-300">
        {merchantName
          ? t("viewer.payment.unlock_failed.contact", { merchant: merchantName })
          : t("viewer.payment.unlock_failed.contact_generic")}
      </p>

      {copyError && (
        <p className="text-xs text-red-400" role="alert">
          {copyError}
        </p>
      )}

      <div className="flex w-full flex-col gap-2 sm:flex-row">
        {reference && (
          <button
            onClick={handleCopy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800"
          >
            {copied
              ? t("viewer.payment.unlock_failed.copied")
              : t("viewer.payment.unlock_failed.copy_reference")}
          </button>
        )}
        <button
          onClick={onReload}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--theme-primary)] px-3 py-2 text-sm font-semibold text-black transition-colors"
        >
          {t("viewer.payment.unlock_failed.reload")}
        </button>
      </div>
    </div>
  );
}
