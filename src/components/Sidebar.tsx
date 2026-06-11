"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useSidebar } from "@/components/SidebarContext";
import { useLocale } from "@/i18n/useLocale";
import UserSection from "@/components/sidebar/UserSection";
import ChannelItem from "@/components/sidebar/ChannelItem";
import ExploreSection from "@/components/sidebar/ExploreSection";
import LanguageSection from "@/components/sidebar/LanguageSection";
import type { SidebarChannel, SidebarCategory } from "@/components/sidebar/types";

interface SidebarProps {
  channels: SidebarChannel[];
  categories: SidebarCategory[];
  channelsByCategory: Record<string, SidebarChannel[]>;
  uncategorized: SidebarChannel[];
}

export default function Sidebar({
  channels,
  categories,
  channelsByCategory,
  uncategorized,
}: SidebarProps) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const { collapsed, toggle } = useSidebar();
  const { t } = useLocale();

  const isActive = (slug: string) => pathname === `/c/${slug}` || pathname.startsWith(`/c/${slug}/`);
  const isHome = pathname === "/";
  const isAdminPage = pathname.startsWith("/admin");
  const isLoggedIn = !!session?.user;
  const isAdmin = isLoggedIn && (session.user as { type?: string }).type === "admin";

  return (
    <>
      {/* Backdrop — always on when the rail is open, on every breakpoint.
          YouTube watch-page model: the rail is an overlay drawer, not a
          flex sibling that pushes content. Click outside to dismiss.
          bg-black/70 matches YouTube's overlay intensity.
          z-40 sits above ALL page content including sticky elements that
          claim z-30 (e.g. the HomeContent category chips). The aside
          drawer at z-50 sits one level above the backdrop. */}
      {!collapsed && (
        <div
          className="fixed inset-0 top-14 z-40 bg-black/70"
          onClick={toggle}
        />
      )}

      <aside
        className={`
          fixed left-0 top-14 z-50 flex h-[calc(100vh-3.5rem)] w-60 flex-col
          transition-transform duration-200
          ${collapsed ? "-translate-x-full" : "translate-x-0"}
        `}
        style={{ backgroundColor: "var(--theme-bg)" }}
      >
        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Section A: Auth + Primary Nav */}
          <div className="px-2 pt-2 pb-1">
            <UserSection
              isLoggedIn={isLoggedIn}
              collapsed={collapsed}
              userName={session?.user?.name}
              t={t}
            />

            <Link
              href="/"
              className={`flex items-center gap-5 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                isHome ? "bg-[var(--theme-bg-secondary)]" : "hover:bg-[var(--theme-bg-secondary)]"
              }`}
              style={{ color: isHome ? "var(--theme-heading)" : "var(--theme-text)" }}
              title={collapsed ? t("viewer.sidebar.home") : undefined}
            >
              {isHome ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M4 21V10.08l8-6.96 8 6.96V21h-6v-6h-4v6H4z" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
              )}
              {!collapsed && <span className={isHome ? "font-medium" : ""}>{t("viewer.sidebar.home")}</span>}
            </Link>

            {isAdmin && (
              <Link
                href="/admin"
                className={`flex items-center gap-5 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  isAdminPage ? "bg-[var(--theme-bg-secondary)]" : "hover:bg-[var(--theme-bg-secondary)]"
                }`}
                style={{ color: isAdminPage ? "var(--theme-heading)" : "var(--theme-text)" }}
                title={collapsed ? t("viewer.sidebar.admin") : undefined}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
                {!collapsed && <span className={isAdminPage ? "font-medium" : ""}>{t("viewer.sidebar.admin")}</span>}
              </Link>
            )}
          </div>

          <div
            className="mx-3 my-1 border-t"
            style={{ borderColor: "var(--theme-border)" }}
          />

          {/* Section B: Channels */}
          <div className="px-2 pt-1 pb-1">
            {!collapsed && (
              <div
                className="flex items-center justify-between px-3 pb-1 pt-2"
              >
                <span
                  className="text-sm font-medium"
                  style={{ color: "var(--theme-heading)" }}
                >
                  {t("viewer.sidebar.channels")}
                </span>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ color: "var(--theme-text-secondary)" }}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            )}

            {/* Categorized channels */}
            {categories.map((cat) => {
              const catChannels = channelsByCategory[cat._id] || [];
              if (catChannels.length === 0) return null;
              return (
                <div key={cat._id}>
                  {!collapsed && (
                    <div
                      className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider"
                      style={{ color: "var(--theme-text-secondary)" }}
                    >
                      {cat.name}
                    </div>
                  )}
                  {catChannels.map((ch) => (
                    <ChannelItem
                      key={ch._id}
                      channel={ch}
                      active={isActive(ch.slug)}
                      collapsed={collapsed}
                    />
                  ))}
                </div>
              );
            })}

            {/* Uncategorized channels */}
            {uncategorized.length > 0 && (
              <div>
                {!collapsed && categories.length > 0 && (
                  <div
                    className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: "var(--theme-text-secondary)" }}
                  >
                    {t("viewer.sidebar.other")}
                  </div>
                )}
                {uncategorized.map((ch) => (
                  <ChannelItem
                    key={ch._id}
                    channel={ch}
                    active={isActive(ch.slug)}
                    collapsed={collapsed}
                  />
                ))}
              </div>
            )}

            {channels.length === 0 && !collapsed && (
              <p
                className="px-3 py-4 text-sm"
                style={{ color: "var(--theme-text-secondary)" }}
              >
                {t("viewer.sidebar.empty")}
              </p>
            )}
          </div>

          {/* Section C: Explore (Categories) — expanded desktop only */}
          {!collapsed && categories.length > 0 && (
            <ExploreSection categories={categories} />
          )}

          {/* Language Switcher — visible when sidebar is expanded (any screen size) */}
          {!collapsed && <LanguageSection />}
        </div>

        {/* Bottom: About (pinned) */}
        <div
          className="shrink-0 border-t px-2 py-2"
          style={{ borderColor: "var(--theme-border)" }}
        >
          <button
            onClick={() => window.dispatchEvent(new Event("open-about"))}
            className="flex w-full items-center gap-5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-[var(--theme-bg-secondary)]"
            style={{ color: "var(--theme-text)" }}
            title={collapsed ? t("viewer.navbar.about") : undefined}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ color: "var(--theme-text-secondary)" }}
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            {!collapsed && <span>{t("viewer.navbar.about")}</span>}
          </button>
        </div>
      </aside>
      {/* No spacer — the rail is now a pure overlay (drawer) on every
          breakpoint. Removing the spacer is what lets the viewer page's
          <main> reclaim the horizontal real estate the icon rail used to
          consume on desktop. */}
    </>
  );
}
