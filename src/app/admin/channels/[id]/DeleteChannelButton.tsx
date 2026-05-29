"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { useLocale } from "@/i18n/useLocale";

interface Props {
  channelId: string;
  name: string;
  mediaCount: number;
}

export default function DeleteChannelButton({
  channelId,
  name,
  mediaCount,
}: Props) {
  const { t } = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmText =
    mediaCount > 0
      ? t("admin.channels.delete_confirm", { name, count: mediaCount })
      : t("admin.channels.delete_confirm_no_media", { name });

  const handleConfirm = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/channels/${channelId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || t("admin.channels.delete_failed"));
      }
      // On success: navigate back to channel list. Use replace so the browser
      // back button doesn't return the user to a now-deleted channel page.
      router.replace("/admin/channels");
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("admin.channels.delete_failed")
      );
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className="rounded-md border border-red-800 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-950"
      >
        {t("admin.channels.delete")}
      </button>

      <Modal
        open={open}
        onClose={() => {
          if (!loading) setOpen(false);
        }}
        title={t("admin.channels.delete_title")}
      >
        <p className="mb-6 text-sm text-[var(--theme-text)]">{confirmText}</p>

        {error && (
          <p className="mb-4 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            type="button"
            onClick={() => setOpen(false)}
            disabled={loading}
          >
            {t("admin.channels.cancel")}
          </Button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
          >
            {loading
              ? t("common.loading")
              : t("admin.channels.delete_action")}
          </button>
        </div>
      </Modal>
    </>
  );
}
