"use client";

import ExpiredAccessBanner from "@/components/ExpiredAccessBanner";
import { useLocale } from "@/i18n/useLocale";
import { formatPrice, formatDuration } from "@/lib/format";

export interface PaywallProduct {
  productId: string;
  encryptedBlob: string;
  keyFingerprint?: string;
  name?: string;
  priceCents?: number;
  currency?: string;
  accessDurationSeconds?: number;
  status?: string;
}

interface ProductButtonsProps {
  products: PaywallProduct[];
  loading: boolean;
  /** When set, shows the "your access expired on [date]" banner above the buttons. */
  expiredAccessAt?: Date;
  onUnlock: (productId: string) => void;
  onOpenExchangeGuide: () => void;
}

/**
 * The unlock surface of the paywall: Bitcoin badge, one buy button per
 * product, and the "need bitcoin?" exchange-guide link. Pure presentation —
 * checkout/decrypt state stays in PaymentWall.
 */
export default function ProductButtons({
  products,
  loading,
  expiredAccessAt,
  onUnlock,
  onOpenExchangeGuide,
}: ProductButtonsProps) {
  const { t, locale } = useLocale();

  return (
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
            onClick={() => onUnlock(product.productId)}
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
        onClick={onOpenExchangeGuide}
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
}
