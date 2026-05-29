"use client";

import { useState, useSyncExternalStore, useId } from "react";
import { useLocale } from "@/i18n/useLocale";
import { useDialog } from "@/components/ui/useDialog";

const STORAGE_KEY = "privapaid_age_verified";
const emptySubscribe = () => () => {};

interface AgeGateProps {
  disclaimer?: string;
}

export default function AgeGate({ disclaimer }: AgeGateProps) {
  const { t } = useLocale();
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const alreadyVerified = useSyncExternalStore(
    emptySubscribe,
    () => sessionStorage.getItem(STORAGE_KEY) === "true",
    () => false,
  );
  const [verified, setVerified] = useState(false);
  const titleId = useId();
  const descId = useId();

  // The gate must be answered, not dismissed: focus trap and scroll lock
  // apply, but Escape does not close it. Keying the hook off isOpen (rather
  // than a constant) lets the scroll lock release once the gate is passed.
  const isOpen = mounted && !verified && !alreadyVerified;
  const dialogRef = useDialog({ open: isOpen, dismissible: false });

  if (!isOpen) return null;

  function handleConfirm() {
    sessionStorage.setItem(STORAGE_KEY, "true");
    setVerified(true);
  }

  function handleDeny() {
    window.location.href = "https://google.com";
  }

  const message =
    disclaimer || t("viewer.age_gate.default_message");

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.95)",
        backdropFilter: "blur(20px)",
        padding: 24,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        style={{
          width: "100%",
          maxWidth: 400,
          textAlign: "center",
          outline: "none",
        }}
      >
        {/* Warning icon */}
        <div
          style={{
            width: 56,
            height: 56,
            margin: "0 auto 24px",
            borderRadius: 14,
            background: "rgba(248, 113, 113, 0.1)",
            border: "1px solid rgba(248, 113, 113, 0.2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#f87171"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>

        <h2
          id={titleId}
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#ffffff",
            marginBottom: 12,
          }}
        >
          {t("viewer.age_gate.title")}
        </h2>

        <p
          id={descId}
          style={{
            fontSize: 14,
            color: "#a1a1aa",
            lineHeight: 1.6,
            marginBottom: 32,
          }}
        >
          {message}
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <button
            onClick={handleConfirm}
            style={{
              width: "100%",
              padding: "14px 32px",
              fontSize: 14,
              fontWeight: 600,
              color: "#ffffff",
              background: "var(--theme-primary)",
              border: "none",
              borderRadius: 980,
              cursor: "pointer",
            }}
          >
            {t("viewer.age_gate.confirm")}
          </button>
          <button
            onClick={handleDeny}
            style={{
              width: "100%",
              padding: "14px 32px",
              fontSize: 14,
              fontWeight: 500,
              color: "#a1a1aa",
              background: "transparent",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              borderRadius: 980,
              cursor: "pointer",
            }}
          >
            {t("viewer.age_gate.deny")}
          </button>
        </div>
      </div>
    </div>
  );
}
