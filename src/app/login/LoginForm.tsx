"use client";

import { useState, Suspense } from "react";
import { signIn } from "next-auth/react";
import { useLocale } from "@/i18n/useLocale";
import type { ThemeConfig } from "@/config/instance";
import { buildAuthTheme } from "@/components/auth/theme";
import PPInput from "@/components/auth/PPInput";
import PPButton from "@/components/auth/PPButton";
import AuthModal from "@/components/auth/AuthModal";
import ErrorPill from "@/components/auth/ErrorPill";
import Logo from "@/components/auth/Logo";

function LoginFormInner({
  instanceName,
  logoUrl,
  themeConfig,
}: {
  instanceName: string;
  logoUrl: string;
  themeConfig: ThemeConfig;
}) {
  const { t } = useLocale();

  const theme = buildAuthTheme(themeConfig);
  const cc = theme.color;
  const cf = theme.font;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await signIn("admin", { redirect: false, email, password });

      const sessionRes = await fetch("/api/auth/session");
      const session = await sessionRes.json();

      if (session?.user) {
        window.location.href = "/admin/channels";
        return;
      }

      setError(t("viewer.login.invalid"));
    } catch {
      try {
        const sessionRes = await fetch("/api/auth/session");
        const session = await sessionRes.json();
        if (session?.user) {
          window.location.href = "/admin/channels";
          return;
        }
      } catch { /* ignore */ }

      setError(t("viewer.login.invalid"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthModal theme={theme}>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <Logo logoUrl={logoUrl} instanceName={instanceName} theme={theme} />
        <h2
          style={{
            fontFamily: cf.display,
            fontSize: 20,
            fontWeight: 700,
            color: cc.white,
            margin: 0,
            letterSpacing: "-0.01em",
          }}
        >
          {t("viewer.login.submit")}
        </h2>
        <p
          style={{
            fontSize: 13,
            color: cc.gray500,
            marginTop: 4,
          }}
        >
          {instanceName}
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <PPInput
          label={t("viewer.login.identity")}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          theme={theme}
        />
        <PPInput
          label={t("viewer.login.password")}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          theme={theme}
        />
        {error && <ErrorPill message={error} theme={theme} />}
        <PPButton type="submit" loading={loading} theme={theme}>
          {t("viewer.login.submit")}
        </PPButton>
      </form>
    </AuthModal>
  );
}

export default function LoginForm({
  instanceName,
  logoUrl,
  themeConfig,
}: {
  instanceName: string;
  logoUrl: string;
  themeConfig: ThemeConfig;
}) {
  return (
    <Suspense>
      <LoginFormInner instanceName={instanceName} logoUrl={logoUrl} themeConfig={themeConfig} />
    </Suspense>
  );
}
