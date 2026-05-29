"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useLocale } from "@/i18n/useLocale";

// Stroke icons (Feather-style, 24 viewBox, stroke-width 2) replace the old
// Unicode glyphs (◆▦◉⬡⇅⚙◎), which rendered inconsistently across platforms and
// clashed with the SVG sync icon below. Each entry is the inner geometry; the
// shared <NavIcon> supplies the wrapper so weight/size stay uniform.
const ICONS: Record<string, React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </>
  ),
  categories: (
    <>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </>
  ),
  channels: (
    <>
      <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
      <polyline points="17 2 12 7 7 2" />
    </>
  ),
  products: (
    <>
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <path d="M16 10a4 4 0 0 1-8 0" />
    </>
  ),
  importExport: (
    <>
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </>
  ),
  settings: (
    <>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </>
  ),
  seo: (
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
};

function NavIcon({ name }: { name: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {ICONS[name]}
    </svg>
  );
}

const navItems = [
  { href: "/admin", labelKey: "admin.sidebar.dashboard", icon: "dashboard" },
  { href: "/admin/categories", labelKey: "admin.sidebar.categories", icon: "categories" },
  { href: "/admin/channels", labelKey: "admin.sidebar.channels", icon: "channels" },
  { href: "/admin/products", labelKey: "admin.sidebar.products", icon: "products" },
  { href: "/admin/import-export", labelKey: "admin.sidebar.importExport", icon: "importExport" },
  { href: "/admin/settings", labelKey: "admin.sidebar.settings", icon: "settings" },
  { href: "/admin/seo", labelKey: "admin.sidebar.seo", icon: "seo" },
];

interface AdminSidebarProps {
  adminName: string;
  adminRole: string;
}

export default function AdminSidebar({
  adminName,
  adminRole,
}: AdminSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useLocale();
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<"idle" | "success" | "error">("idle");

  async function handleSync() {
    setSyncing(true);
    setSyncStatus("idle");

    try {
      const res = await fetch("/api/admin/settings/sync", { method: "POST" });
      if (!res.ok) {
        setSyncStatus("error");
        return;
      }
      setSyncStatus("success");
      router.refresh();
    } catch {
      setSyncStatus("error");
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncStatus("idle"), 3000);
    }
  }

  return (
    // The rail keeps a fixed dark palette by design — a two-tone admin (dark
    // rail, light content) is the intended look, so the zinc grays are not
    // operator-themeable. Only the accent (wordmark, active state, focus) is
    // wired to --theme-primary so the brand color flows through.
    <aside className="flex w-56 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="border-b border-zinc-800 px-4 py-4">
        <Link href="/admin" className="flex items-center gap-2">
          <span
            className="text-lg font-bold"
            style={{ color: "var(--theme-primary)" }}
          >
            PrivaPaid
          </span>
          <span className="text-sm font-medium text-zinc-400">Stream</span>
        </Link>
      </div>

      <nav className="flex-1 space-y-1 px-2 py-4">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/admin" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-zinc-800 text-white shadow-[inset_2px_0_0_var(--theme-primary)]"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              <NavIcon name={item.icon} />
              {t(item.labelKey)}
            </Link>
          );
        })}
      </nav>

      {/* Sync button */}
      <div className="border-t border-zinc-800 px-3 py-3">
        <button
          onClick={handleSync}
          disabled={syncing}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${
            syncStatus === "success"
              ? "text-green-400"
              : syncStatus === "error"
                ? "text-red-400"
                : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          }`}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={syncing ? "animate-spin" : ""}
          >
            <path d="M21 2v6h-6" />
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M3 22v-6h6" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          </svg>
          {syncing
            ? t("admin.sidebar.syncing")
            : syncStatus === "success"
              ? t("admin.sidebar.synced")
              : syncStatus === "error"
                ? t("admin.sidebar.sync_failed")
                : t("admin.sidebar.sync")}
        </button>
      </div>

      <div className="border-t border-zinc-800 px-4 py-4">
        <Link
          href="/"
          className="mb-3 flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200"
        >
          {t("admin.sidebar.viewSite")} ↗
        </Link>
        <p className="truncate text-sm font-medium text-zinc-200">
          {adminName}
        </p>
        <p className="text-xs text-zinc-500 capitalize">{adminRole}</p>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="mt-3 text-xs text-zinc-500 hover:text-zinc-300"
        >
          {t("admin.sidebar.logout")}
        </button>
      </div>
    </aside>
  );
}
