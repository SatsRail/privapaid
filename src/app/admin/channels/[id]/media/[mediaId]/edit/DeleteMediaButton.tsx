"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "@/i18n/useLocale";

interface Props {
  mediaId: string;
  channelId: string;
  name: string;
}

export default function DeleteMediaButton({ mediaId, channelId, name }: Props) {
  const { t } = useLocale();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleDelete = async () => {
    if (!window.confirm(t("admin.media.delete_confirm", { name }))) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/media/${mediaId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || t("admin.media.delete_failed"));
      }
      router.push(`/admin/channels/${channelId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.media.delete_failed"));
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-5">
      <h2 className="text-sm font-semibold text-red-300">
        {t("admin.media.danger_zone")}
      </h2>
      <p className="mt-1 text-sm text-[var(--theme-text-secondary)]">
        {t("admin.media.delete_description")}
      </p>
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={handleDelete}
          disabled={loading}
          className="rounded-md border border-red-800 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950 disabled:opacity-50"
        >
          {loading ? t("common.loading") : t("common.delete")}
        </button>
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </div>
  );
}
