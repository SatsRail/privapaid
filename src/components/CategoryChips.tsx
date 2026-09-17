"use client";
import { useLocale } from "@/i18n/useLocale";

interface CategoryChipsProps {
  categories: { _id: string; name: string }[];
  activeCategory: string | null;
  onSelect: (id: string | null) => void;
}

export default function CategoryChips({ categories, activeCategory, onSelect }: CategoryChipsProps) {
  const { t } = useLocale();
  return (
    <div className="scrollbar-hide flex gap-3 overflow-x-auto pb-1">
      <button
        onClick={() => onSelect(null)}
        aria-pressed={activeCategory === null}
        className={`min-h-11 shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
          activeCategory === null
            ? "bg-white text-black"
            : "bg-[var(--theme-bg-secondary)] text-[var(--theme-text)] hover:bg-[#3f3f3f]"
        }`}
      >
        {t("viewer.home.all")}
      </button>
      {categories.map((cat) => (
        <button
          key={cat._id}
          onClick={() => onSelect(cat._id)}
          aria-pressed={activeCategory === cat._id}
          className={`min-h-11 shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
            activeCategory === cat._id
              ? "bg-white text-black"
              : "bg-[var(--theme-bg-secondary)] text-[var(--theme-text)] hover:bg-[#3f3f3f]"
          }`}
        >
          {cat.name}
        </button>
      ))}
    </div>
  );
}
