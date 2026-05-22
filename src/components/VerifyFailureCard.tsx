"use client";

import { useLocale } from "@/i18n/useLocale";
import AlertIcon from "@/components/icons/AlertIcon";

interface VerifyFailureCardProps {
  /** When the verification attempt failed (ms epoch). */
  failedAt: number;
  /** Merchant name for the contact line — falls back to a generic message. */
  merchantName?: string;
  /** Called when the user clicks "Reload page". */
  onReload: () => void;
}

/**
 * Shown to a customer who has a stored macaroon for this content but whose
 * mount-time verification hit a transient failure (network, portal 5xx,
 * fingerprint drift). Their access is likely still valid — prompt a reload
 * rather than asking them to re-pay.
 */
export default function VerifyFailureCard({
  failedAt,
  merchantName,
  onReload,
}: VerifyFailureCardProps) {
  const { t, locale } = useLocale();

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4 px-2 text-center">
      <AlertIcon variant="info" />

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
            {new Date(failedAt).toLocaleString(locale)}
          </span>
        </div>
      </div>

      <p className="text-sm text-zinc-300">
        {merchantName
          ? t("viewer.payment.unlock_failed.contact", { merchant: merchantName })
          : t("viewer.payment.unlock_failed.contact_generic")}
      </p>

      <button
        onClick={onReload}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--theme-primary)] px-3 py-2 text-sm font-semibold text-black transition-colors"
      >
        {t("viewer.payment.unlock_failed.reload")}
      </button>
    </div>
  );
}
