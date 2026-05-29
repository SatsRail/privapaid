"use client";

import Modal from "@/components/ui/Modal";
import { useLocale } from "@/i18n/useLocale";

interface AboutModalProps {
  open: boolean;
  onClose: () => void;
  aboutText: string;
  instanceName: string;
}

export default function AboutModal({
  open,
  onClose,
  aboutText,
  instanceName,
}: AboutModalProps) {
  const { t } = useLocale();

  return (
    <Modal open={open} onClose={onClose} title={t("viewer.navbar.about")}>
      <p className="mb-2 text-sm font-medium text-[var(--theme-heading)]">
        {instanceName}
      </p>

      {aboutText ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--theme-text)]">
          {aboutText}
        </p>
      ) : (
        <p className="text-sm italic text-[var(--theme-text-secondary)]">—</p>
      )}

      <div className="mt-6 flex justify-end">
        <button
          onClick={onClose}
          className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--theme-text-secondary)] transition-colors hover:bg-[var(--theme-bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-primary)]"
        >
          {t("common.cancel")}
        </button>
      </div>
    </Modal>
  );
}
