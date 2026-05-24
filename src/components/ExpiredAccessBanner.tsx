"use client";

import { useLocale } from "@/i18n/useLocale";

interface ExpiredAccessBannerProps {
  expiredAt: Date;
}

/**
 * Renders the "your access expired on [date], pay to renew" surface above
 * the unlock buttons. Shown when the viewer's cookie holds an expired
 * macaroon for one of this media's products — i.e., they USED to have
 * access and the time they paid for has run out.
 *
 * Distinct from VerifyFailureCard (which is for "we couldn't reach the
 * portal") and UnlockFailureCard (which is for "you just paid and
 * decryption failed"). This is for the routine "your subscription
 * lapsed" case — silent before, now explicit.
 *
 * The date is formatted in the viewer's locale and includes the time, so
 * a "expired 30 seconds ago" prompt doesn't lie by rounding to the day.
 */
export default function ExpiredAccessBanner({ expiredAt }: ExpiredAccessBannerProps) {
  const { t, locale } = useLocale();
  const formatted = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(expiredAt);

  return (
    <div
      role="status"
      data-testid="expired-access-banner"
      className="mb-5 w-full max-w-sm overflow-hidden rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-900/30 via-amber-950/40 to-orange-950/40 px-4 py-3 shadow-[0_0_24px_-12px_rgba(245,158,11,0.5)] ring-1 ring-inset ring-amber-400/10"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/15 ring-1 ring-inset ring-amber-400/30">
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-amber-300"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tracking-tight text-amber-100">
            {t("viewer.payment.expired_banner.title")}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-amber-100/70">
            {t("viewer.payment.expired_banner.body", { date: formatted })}
          </p>
        </div>
      </div>
    </div>
  );
}
