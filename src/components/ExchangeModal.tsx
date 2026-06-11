"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import Modal from "@/components/ui/Modal";
import { useLocale } from "@/i18n/useLocale";

interface ExchangeCountry {
  id: string;
  name: string;
  iso_code: string;
}

interface Exchange {
  id: string;
  name: string;
  url: string;
  promoted: boolean;
  min_transaction_sats: number | null;
  notes: string | null;
  logo_url: string | null;
  countries: ExchangeCountry[];
}

interface ExchangeData {
  exchanges: Exchange[];
  country_code: string | null;
}

interface ExchangeModalProps {
  open: boolean;
  onClose: () => void;
}

export default function ExchangeModal({ open, onClose }: ExchangeModalProps) {
  const { t } = useLocale();
  const [showAll, setShowAll] = useState(false);

  const params = showAll ? "?all=1" : "";
  const { data, isLoading: loading } = useSWR<ExchangeData>(
    open ? `/api/exchanges${params}` : null,
    fetcher
  );

  const exchanges = data?.exchanges ?? [];
  const countryCode = data?.country_code ?? null;

  function handleShowAll() {
    setShowAll(true);
  }

  return (
    <Modal open={open} onClose={onClose} title={t("viewer.exchange_guide.title")}>
      <p className="mb-4 text-sm text-[var(--theme-text-secondary)]">
        {t("viewer.exchange_guide.description")}
        {countryCode && !showAll && (
          <span> {t("viewer.exchange_guide.your_country")}</span>
        )}
      </p>

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--theme-primary)] border-t-transparent" />
        </div>
      ) : exchanges.length > 0 ? (
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {exchanges.map((exchange) => (
            <a
              key={exchange.id}
              href={exchange.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-lg border border-[var(--theme-border)] p-3 transition hover:border-[var(--theme-primary)]"
            >
              {exchange.logo_url ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={exchange.logo_url}
                  alt={exchange.name}
                  className="h-8 w-8 rounded object-contain"
                />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded bg-[var(--theme-primary)] text-sm font-bold text-black">
                  {exchange.name.charAt(0)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[var(--theme-text)]">
                    {exchange.name}
                  </span>
                  {exchange.promoted && (
                    <span className="rounded bg-[var(--theme-primary)] px-1.5 py-0.5 text-[10px] font-semibold text-black">
                      {t("viewer.exchange_guide.featured")}
                    </span>
                  )}
                </div>
                {exchange.notes && (
                  <p className="truncate text-xs text-[var(--theme-text-secondary)]">
                    {exchange.notes}
                  </p>
                )}
              </div>
              <svg
                className="h-4 w-4 flex-shrink-0 text-[var(--theme-text-secondary)]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </a>
          ))}
        </div>
      ) : (
        <p className="py-4 text-center text-sm text-[var(--theme-text-secondary)]">
          {t("viewer.exchange_guide.empty")}
        </p>
      )}

      {countryCode && !showAll && exchanges.length > 0 && (
        <button
          onClick={handleShowAll}
          className="mt-3 w-full text-center text-sm text-[var(--theme-primary)] hover:underline"
        >
          {t("viewer.exchange_guide.show_all")}
        </button>
      )}
    </Modal>
  );
}
