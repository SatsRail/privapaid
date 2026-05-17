"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "@/i18n/useLocale";

interface SearchBarProps {
  placeholder?: string;
}

export default function SearchBar({ placeholder }: SearchBarProps) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const router = useRouter();

  interface SearchResult {
    type: "channel" | "media";
    id: string;
    name: string;
    slug: string;
    channelSlug?: string;
    thumbnail?: string;
    mediaType?: string;
  }

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.results || []);
        setOpen(true);
      }
    } catch {
      // Silently fail — search is non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = (value: string) => {
    setQuery(value);
    setActiveIndex(-1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(value), 300);
  };

  const navigate = (result: SearchResult) => {
    setOpen(false);
    setQuery("");
    if (result.type === "channel") {
      router.push(`/c/${result.slug}`);
    } else {
      router.push(`/c/${result.channelSlug}/${result.id}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) {
      if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i < results.length - 1 ? i + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i > 0 ? i - 1 : results.length - 1));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      navigate(results[activeIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={containerRef} className="relative w-full max-w-[600px]">
      <div className="flex items-stretch">
        {/* Input pill — left side */}
        <div
          className="flex min-w-0 flex-1 items-center rounded-l-full border py-2 pl-4 pr-3 transition-colors"
          style={{
            backgroundColor: "var(--theme-bg)",
            borderColor: focused ? "var(--theme-primary)" : "var(--theme-border)",
          }}
        >
          {focused && (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mr-2 shrink-0"
              style={{ color: "var(--theme-text)" }}
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={() => {
              setFocused(true);
              if (results.length > 0) setOpen(true);
            }}
            onBlur={() => setFocused(false)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder || t("viewer.search.placeholder")}
            className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--theme-text-secondary)]"
            style={{ color: "var(--theme-text)" }}
          />
          {loading && (
            <div
              className="ml-2 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-t-transparent"
              style={{ borderColor: "var(--theme-text-secondary)", borderTopColor: "transparent" }}
            />
          )}
          {query && !loading && (
            <button
              onClick={() => { setQuery(""); setResults([]); setOpen(false); }}
              className="ml-2 shrink-0 transition-colors hover:text-[var(--theme-text)]"
              style={{ color: "var(--theme-text-secondary)" }}
              aria-label="Clear search"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* Search button — right side */}
        <button
          onClick={() => { if (query.trim()) search(query); }}
          className="flex items-center justify-center rounded-r-full border border-l-0 px-5 transition-colors hover:brightness-125"
          style={{
            backgroundColor: "var(--theme-bg-secondary)",
            borderColor: focused ? "var(--theme-primary)" : "var(--theme-border)",
          }}
          aria-label="Search"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: "var(--theme-text)" }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
      </div>

      {/* Dropdown results */}
      {open && results.length > 0 && (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-xl shadow-xl"
          style={{ backgroundColor: "var(--theme-bg-secondary)" }}
        >
          {results.map((result, i) => (
            <button
              key={`${result.type}-${result.id}`}
              onClick={() => navigate(result)}
              className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
                i === activeIndex ? "bg-[#3f3f3f]" : "hover:bg-[#3f3f3f]"
              }`}
            >
              {result.type === "channel" ? (
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                  style={{
                    backgroundColor: "var(--theme-bg)",
                    color: "var(--theme-text-secondary)",
                  }}
                >
                  {result.name.charAt(0).toUpperCase()}
                </div>
              ) : (
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-xs"
                  style={{
                    backgroundColor: "var(--theme-bg)",
                    color: "var(--theme-text-secondary)",
                  }}
                >
                  {result.mediaType === "video" && "\u25B6"}
                  {result.mediaType === "audio" && "\u266B"}
                  {result.mediaType === "article" && "\uD83D\uDCC4"}
                  {result.mediaType === "photo" && "\uD83D\uDDBC"}
                  {result.mediaType === "podcast" && "\uD83C\uDF99"}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate" style={{ color: "var(--theme-text)" }}>
                  {result.name}
                </div>
                <div className="text-xs" style={{ color: "var(--theme-text-secondary)" }}>
                  {result.type === "channel" ? t("viewer.search.channel") : `${t("viewer.search.media")} \u00B7 ${result.channelSlug}`}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {open && query.trim().length >= 2 && results.length === 0 && !loading && (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1 rounded-xl px-4 py-3 text-center text-sm shadow-xl"
          style={{
            backgroundColor: "var(--theme-bg-secondary)",
            color: "var(--theme-text-secondary)",
          }}
        >
          {t("viewer.search.no_results")}
        </div>
      )}
    </div>
  );
}
