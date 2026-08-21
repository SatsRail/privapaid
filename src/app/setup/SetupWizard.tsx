"use client";

import { useState } from "react";

interface MerchantInfo {
  merchant_id: string;
  merchant_name: string;
  merchant_currency: string;
  merchant_locale: string;
  merchant_logo_url: string;
}

/* ─── Design tokens ─── */

const font = {
  display: "'Space Grotesk', sans-serif",
  body: "'Inter', sans-serif",
};

const color = {
  bg: "#08080d",
  card: "#111119",
  accent: "#c9506b",
  accentLight: "#d4738a",
  accentGlow: "rgba(201, 80, 107, 0.10)",
  white: "#ffffff",
  gray100: "#f0f0f5",
  gray300: "#b8b8c8",
  gray500: "#80809a",
  gray700: "#222233",
  green: "#34d399",
  red: "#f87171",
  border: "rgba(255, 255, 255, 0.06)",
};

/* ─── Components ─── */

function PadlockLogo() {
  return (
    <div
      style={{
        width: 72,
        height: 72,
        margin: "0 auto 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 18,
        background: "rgba(201, 80, 107, 0.08)",
        boxShadow: `0 0 48px ${color.accentGlow}, 0 0 96px ${color.accentGlow}`,
        animation: "ppLogoPulse 4s ease-in-out infinite",
        overflow: "hidden",
      }}
    >
      <style>{`
        @keyframes ppLogoPulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 48px ${color.accentGlow}, 0 0 96px ${color.accentGlow}; }
          50% { transform: scale(1.02); box-shadow: 0 0 64px rgba(201,80,107,0.15), 0 0 128px rgba(201,80,107,0.08); }
        }
        @keyframes ppFadeUp {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes ppSlideIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes spin { to { transform: rotate(360deg) } }
      `}</style>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo.png"
        alt="PrivaPaid"
        style={{ width: 56, height: 56, objectFit: "contain" }}
      />
    </div>
  );
}

function PPButton({
  variant = "primary",
  loading = false,
  children,
  style: styleProp,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
  loading?: boolean;
}) {
  const isPrimary = variant === "primary";

  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "14px 32px",
        fontSize: 14,
        fontWeight: 600,
        fontFamily: font.body,
        letterSpacing: "0.01em",
        color: isPrimary ? color.white : color.gray300,
        background: isPrimary ? color.accent : "transparent",
        border: isPrimary ? "none" : `1px solid ${color.border}`,
        borderRadius: 980,
        cursor: props.disabled || loading ? "not-allowed" : "pointer",
        opacity: props.disabled || loading ? 0.5 : 1,
        transition: "all 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
        boxSizing: "border-box",
        ...styleProp,
      }}
      onMouseEnter={(e) => {
        if (!props.disabled && !loading) {
          if (isPrimary) {
            e.currentTarget.style.background = color.accentLight;
            e.currentTarget.style.transform = "scale(1.02)";
            e.currentTarget.style.boxShadow = `0 4px 24px ${color.accentGlow}`;
          } else {
            e.currentTarget.style.background = "rgba(255,255,255,0.04)";
          }
        }
      }}
      onMouseLeave={(e) => {
        if (isPrimary) {
          e.currentTarget.style.background = color.accent;
          e.currentTarget.style.transform = "scale(1)";
          e.currentTarget.style.boxShadow = "none";
        } else {
          e.currentTarget.style.background = "transparent";
        }
      }}
      onMouseDown={(e) => {
        if (!props.disabled && !loading) {
          e.currentTarget.style.transform = "scale(0.98)";
        }
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = "scale(1)";
      }}
    >
      {loading && (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          style={{ animation: "spin 1s linear infinite" }}
        >
          <circle
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="3"
            opacity="0.25"
          />
          <path
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            fill="currentColor"
            opacity="0.75"
          />
        </svg>
      )}
      {children}
    </button>
  );
}

/* ─── Main Wizard ─── */

export default function SetupWizard() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [merchant, setMerchant] = useState<MerchantInfo | null>(null);
  const [apiKey, setApiKey] = useState("");

  async function verifyKey() {
    if (!apiKey.trim()) {
      setError("API key is required");
      return;
    }

    setVerifying(true);
    setError("");

    try {
      const res = await fetch("/api/setup/verify-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ satsrail_api_key: apiKey }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Invalid API key");
        setMerchant(null);
        return;
      }

      setMerchant(data);
    } catch {
      setError("Failed to verify key. Check your connection.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleSubmit() {
    if (!merchant) {
      setError("Please verify your API key first");
      return;
    }

    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instance_name: merchant.merchant_name,
          logo_url: merchant.merchant_logo_url,
          satsrail_api_key: apiKey,
          merchant_id: merchant.merchant_id,
          merchant_name: merchant.merchant_name,
          merchant_currency: merchant.merchant_currency,
          merchant_locale: merchant.merchant_locale,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Setup failed");
        return;
      }

      window.location.href = "/login";
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ animation: "ppFadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1)" }}>
      {/* ── Header ── */}
      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <PadlockLogo />

        <h1
          style={{
            fontFamily: font.display,
            fontSize: 32,
            fontWeight: 700,
            color: color.white,
            margin: 0,
            letterSpacing: "-0.02em",
          }}
        >
          Priva<span style={{ color: color.accent }}>Paid</span>
        </h1>

        <p
          style={{
            fontFamily: font.body,
            fontSize: 14,
            color: color.gray500,
            marginTop: 8,
            fontWeight: 400,
          }}
        >
          Connect your SatsRail merchant account
        </p>
      </div>

      {/* ── Card ── */}
      <div
        style={{
          background: color.card,
          border: `1px solid ${color.border}`,
          borderRadius: 20,
          padding: 32,
          backdropFilter: "blur(20px)",
          boxShadow: "0 1px 2px rgba(0,0,0,0.3), 0 8px 32px rgba(0,0,0,0.2)",
        }}
      >
        {/* API Key input */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 500,
              color: color.gray300,
              marginBottom: 8,
              fontFamily: font.body,
              letterSpacing: "0.01em",
            }}
          >
            SatsRail API Key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setError("");
              if (merchant) setMerchant(null);
            }}
            placeholder="sk_live_..."
            style={{
              width: "100%",
              padding: "14px 16px",
              fontSize: 14,
              fontFamily: font.body,
              fontWeight: 400,
              color: color.white,
              backgroundColor: color.bg,
              border: `1px solid ${color.border}`,
              borderRadius: 12,
              outline: "none",
              transition: "border-color 0.25s, box-shadow 0.25s",
              boxSizing: "border-box",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = color.accent;
              e.currentTarget.style.boxShadow = `0 0 0 3px ${color.accentGlow}`;
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = color.border;
              e.currentTarget.style.boxShadow = "none";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !merchant) verifyKey();
            }}
          />
          <p
            style={{
              fontSize: 12,
              color: color.gray500,
              marginTop: 6,
              fontFamily: font.body,
            }}
          >
            From your SatsRail merchant dashboard
          </p>
        </div>

        {!merchant ? (
          <div>
            <PPButton
              variant="secondary"
              onClick={verifyKey}
              loading={verifying}
              style={{ width: "100%" }}
            >
              Connect Account
            </PPButton>
            <p
              style={{
                fontSize: 12,
                color: color.gray500,
                marginTop: 16,
                fontFamily: font.body,
                textAlign: "center",
                lineHeight: 1.5,
              }}
            >
              Don&apos;t have an account?{" "}
              <a
                href="https://www.satsrail.com/merchants/sign_up"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: color.accent,
                  textDecoration: "none",
                  fontWeight: 500,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.textDecoration = "underline";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.textDecoration = "none";
                }}
              >
                Create a SatsRail account
              </a>
            </p>
          </div>
        ) : (
          /* ── Merchant revealed ── */
          <div
            style={{
              animation: "ppSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
              display: "flex",
              alignItems: "center",
              gap: 16,
              padding: "16px 20px",
              borderRadius: 14,
              background: "rgba(52, 211, 153, 0.04)",
              border: "1px solid rgba(52, 211, 153, 0.12)",
            }}
          >
            {merchant.merchant_logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={merchant.merchant_logo_url}
                alt={merchant.merchant_name}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  objectFit: "contain",
                  background: color.bg,
                  padding: 4,
                }}
              />
            ) : (
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  background: color.bg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                  fontWeight: 700,
                  color: color.accent,
                  fontFamily: font.display,
                }}
              >
                {merchant.merchant_name.charAt(0)}
              </div>
            )}
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: color.white,
                  fontFamily: font.body,
                }}
              >
                {merchant.merchant_name}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: color.green,
                  fontWeight: 500,
                  fontFamily: font.body,
                  marginTop: 2,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path
                    d="M2.5 6L5 8.5L9.5 3.5"
                    stroke={color.green}
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Connected
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Error ── */}
      {error && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            padding: "12px 16px",
            borderRadius: 12,
            background: "rgba(248, 113, 113, 0.06)",
            border: "1px solid rgba(248, 113, 113, 0.15)",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="8" fill={color.red} opacity="0.15" />
            <path
              d="M8 5v3.5M8 10.5v.5"
              stroke={color.red}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span
            style={{
              fontSize: 13,
              color: color.red,
              fontFamily: font.body,
              fontWeight: 500,
            }}
          >
            {error}
          </span>
        </div>
      )}

      {/* ── Submit ── */}
      {merchant && (
        <div
          style={{
            marginTop: 24,
            animation: "ppSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          <PPButton
            onClick={handleSubmit}
            loading={loading}
            style={{ width: "100%" }}
          >
            Complete Setup
          </PPButton>
          <p
            style={{
              fontSize: 12,
              color: color.gray500,
              marginTop: 12,
              fontFamily: font.body,
              textAlign: "center",
              lineHeight: 1.5,
            }}
          >
            After setup, sign in with your SatsRail credentials.
          </p>
        </div>
      )}

      {/* ── Footer ── */}
      <p
        style={{
          textAlign: "center",
          fontSize: 11,
          color: color.gray500,
          marginTop: 32,
          fontFamily: font.body,
          letterSpacing: "0.02em",
        }}
      >
        Powered by{" "}
        <span style={{ color: color.gray300, fontWeight: 500 }}>SatsRail</span>
      </p>
    </div>
  );
}
