"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";

interface UserSectionProps {
  isLoggedIn: boolean;
  collapsed: boolean;
  userName: string | null | undefined;
  t: (key: string) => string;
}

/** Login link (logged out) or avatar + name + logout (logged in). */
export default function UserSection({
  isLoggedIn,
  collapsed,
  userName,
  t,
}: UserSectionProps) {
  const initial = (userName || "?").charAt(0).toUpperCase();
  const avatarStyle = { backgroundColor: "var(--theme-primary)", color: "#000" };

  if (!isLoggedIn) {
    return (
      <Link
        href="/login"
        className="flex items-center gap-5 rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-[var(--theme-bg-secondary)]"
        style={{ color: "var(--theme-text)" }}
        title={collapsed ? t("viewer.navbar.login") : undefined}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--theme-text-secondary)" }}>
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        {!collapsed && <span>{t("viewer.navbar.login")}</span>}
      </Link>
    );
  }

  const avatar = (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold" style={avatarStyle} title={userName || "Admin"}>
      {initial}
    </div>
  );

  const nameEl = (
    <span className="truncate text-sm font-medium" style={{ color: "var(--theme-text)" }}>
      {userName}
    </span>
  );

  return (
    <div className="flex items-center gap-5 rounded-lg px-3 py-2">
      {avatar}
      {!collapsed && (
        <div className="min-w-0 flex-1 flex flex-col">
          {nameEl}
          <button
            onClick={() => signOut({ callbackUrl: "/" })}
            className="text-xs text-left transition-colors hover:opacity-80"
            style={{ color: "var(--theme-text-secondary)" }}
          >
            {t("viewer.navbar.logout")}
          </button>
        </div>
      )}
    </div>
  );
}
