"use client";

import { useState, useEffect, useRef } from "react";
import { formatTime } from "@/lib/format-time";
import { t } from "@/i18n";

interface AccessTimerPillProps {
  serverSeconds: number;
  locale: string;
}

export default function AccessTimerPill({
  serverSeconds,
  locale,
}: AccessTimerPillProps) {
  const [displaySeconds, setDisplaySeconds] = useState(Math.max(0, Math.floor(serverSeconds)));
  const syncRef = useRef<{ serverSeconds: number; syncTime: number } | null>(null);

  useEffect(() => {
    const floored = Math.max(0, Math.floor(serverSeconds));
    syncRef.current = { serverSeconds: floored, syncTime: Date.now() };

    function tick() {
      if (!syncRef.current) return;
      const { serverSeconds: ss, syncTime } = syncRef.current;
      const elapsed = Math.floor((Date.now() - syncTime) / 1000);
      setDisplaySeconds(Math.max(0, ss - elapsed));
    }

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [serverSeconds]);

  const warning = displaySeconds <= 300 && displaySeconds > 60;
  const critical = displaySeconds <= 60;

  const colorClasses = critical
    ? "bg-[var(--theme-error)]/15 border border-[var(--theme-error)]/40 text-[var(--theme-error)]"
    : warning
      ? "bg-[var(--theme-warning)]/15 border border-[var(--theme-warning)]/40 text-[var(--theme-warning)]"
      : "bg-[var(--theme-bg-secondary)] text-[var(--theme-text)]";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${colorClasses}`}
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
        className={critical ? "animate-pulse" : ""}
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <span className="tabular-nums">
        {t(locale, "viewer.media.access_label")} {formatTime(displaySeconds)}
      </span>
    </span>
  );
}
