"use client";

import { useLocale } from "@/i18n/useLocale";

/**
 * Access-first placeholder. Shown while the access hook is still verifying
 * and during the brief active-but-still-decrypting window. Honors the hook's
 * documented "loading → render nothing (yet)" contract so a returning paid
 * viewer never sees the buy buttons flash before content appears. Sized to
 * swap in for the buttons without layout shift.
 */
export default function CheckingAccessPlaceholder() {
  const { t } = useLocale();
  return (
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
}
