"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "@/i18n/useLocale";

interface Props {
  mediaId: string;
}

interface ReencryptResult {
  total: number;
  reencrypted: number;
  errors: { satsrailProductId: string; error: string }[];
}

type Status = { kind: "ok" | "partial" | "none" | "error"; text: string };

export default function ReEncryptButton({ mediaId }: Props) {
  const { t } = useLocale();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  const handleReencrypt = async () => {
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/admin/media/${mediaId}/re-encrypt`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || t("admin.media.reencrypt_failed"));
      }
      const r = body as ReencryptResult;
      if (r.total === 0) {
        setStatus({ kind: "none", text: t("admin.media.reencrypt_none") });
      } else if (r.errors.length > 0) {
        setStatus({
          kind: "partial",
          text: t("admin.media.reencrypt_partial", {
            reencrypted: r.reencrypted,
            total: r.total,
            errors: r.errors.length,
          }),
        });
      } else {
        setStatus({
          kind: "ok",
          text: t("admin.media.reencrypt_done", {
            reencrypted: r.reencrypted,
            total: r.total,
          }),
        });
        // Refresh so the encrypted-blob previews on the form reflect the new wraps.
        router.refresh();
      }
    } catch (err) {
      setStatus({
        kind: "error",
        text: err instanceof Error ? err.message : t("admin.media.reencrypt_failed"),
      });
    } finally {
      setLoading(false);
    }
  };

  const statusColor =
    status?.kind === "ok"
      ? "text-green-400"
      : status?.kind === "error" || status?.kind === "partial"
        ? "text-red-400"
        : "text-[var(--theme-text-secondary)]";

  return (
    <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-5">
      <h2 className="text-sm font-semibold">{t("admin.media.reencrypt_title")}</h2>
      <p className="mt-1 text-sm text-[var(--theme-text-secondary)]">
        {t("admin.media.reencrypt_description")}
      </p>
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={handleReencrypt}
          disabled={loading}
          className="rounded-md border border-[var(--theme-border)] px-3 py-1.5 text-sm hover:opacity-80 disabled:opacity-50"
        >
          {loading ? t("admin.media.reencrypt_running") : t("admin.media.reencrypt")}
        </button>
        {status && <span className={`text-sm ${statusColor}`}>{status.text}</span>}
      </div>
    </div>
  );
}
