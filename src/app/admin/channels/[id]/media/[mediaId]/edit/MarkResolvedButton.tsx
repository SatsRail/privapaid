"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "@/i18n/useLocale";

interface Props {
  mediaId: string;
}

export default function MarkResolvedButton({ mediaId }: Props) {
  const { t } = useLocale();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleResolve = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/media/${mediaId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ok" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || t("admin.media.mark_resolved_failed"));
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.media.mark_resolved_failed"));
      setLoading(false);
    }
  };

  return (
    <div className="mt-4 flex items-center gap-3">
      <button
        onClick={handleResolve}
        disabled={loading}
        className="rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] px-3 py-1.5 text-sm hover:opacity-80 disabled:opacity-50"
      >
        {loading ? t("common.loading") : t("admin.media.mark_resolved")}
      </button>
      {error && <span className="text-sm text-red-400">{error}</span>}
    </div>
  );
}
