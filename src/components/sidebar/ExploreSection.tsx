"use client";

import Link from "next/link";
import { useLocale } from "@/i18n/useLocale";
import type { SidebarCategory } from "./types";

/** "Explore" category links — expanded desktop only (caller gates rendering). */
export default function ExploreSection({ categories }: { categories: SidebarCategory[] }) {
  const { t } = useLocale();
  return (
    <div className="hidden lg:block">
      <div
        className="mx-3 my-1 border-t"
        style={{ borderColor: "var(--theme-border)" }}
      />
      <div className="px-2 pt-1 pb-2">
        <div className="px-3 pb-1 pt-2">
          <span
            className="text-sm font-medium"
            style={{ color: "var(--theme-heading)" }}
          >
            {t("viewer.sidebar.explore")}
          </span>
        </div>
        {categories.map((cat) => (
          <Link
            key={cat._id}
            href={`/?category=${cat._id}`}
            className="flex items-center gap-5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-[var(--theme-bg-secondary)]"
            style={{ color: "var(--theme-text)" }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ color: "var(--theme-text-secondary)" }}
            >
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            <span>{cat.name}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
