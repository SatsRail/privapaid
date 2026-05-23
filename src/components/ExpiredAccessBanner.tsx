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
      className="mb-4 w-full max-w-sm rounded-lg border border-amber-700/40 bg-amber-900/20 px-4 py-3"
    >
      <p className="text-sm font-semibold text-amber-200">
        {t("viewer.payment.expired_banner.title")}
      </p>
      <p className="mt-1 text-xs text-amber-100/80">
        {t("viewer.payment.expired_banner.body", { date: formatted })}
      </p>
    </div>
  );
}
