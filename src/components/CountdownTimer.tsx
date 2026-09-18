"use client";

import { useState, useEffect, useRef } from "react";
import { formatTime } from "@/lib/format-time";

interface CountdownTimerProps {
  serverSeconds: number;
  onExpired?: () => void;
}

export default function CountdownTimer({
  serverSeconds,
  onExpired,
}: CountdownTimerProps) {
  const [displaySeconds, setDisplaySeconds] = useState(Math.max(0, Math.floor(serverSeconds)));
  const syncRef = useRef<{ serverSeconds: number; syncTime: number } | null>(null);
  const expiredRef = useRef(false);

  // Sync from server heartbeat + run 1s countdown
  useEffect(() => {
    const floored = Math.max(0, Math.floor(serverSeconds));
    syncRef.current = { serverSeconds: floored, syncTime: Date.now() };
    expiredRef.current = false;

    function tick() {
      if (!syncRef.current) return;
      const { serverSeconds: ss, syncTime } = syncRef.current;
      const elapsed = Math.floor((Date.now() - syncTime) / 1000);
      const remaining = Math.max(0, ss - elapsed);
      setDisplaySeconds(remaining);

      if (remaining === 0 && !expiredRef.current) {
        expiredRef.current = true;
        onExpired?.();
      }
    }

    // Snap display immediately
    tick();

    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [serverSeconds, onExpired]);

  const warning = displaySeconds <= 300 && displaySeconds > 60;
  const critical = displaySeconds <= 60;

  return (
    <div
      className={`
        inline-flex items-center gap-1.5 rounded-full px-3 py-1.5
        backdrop-blur-sm transition-colors duration-500
        ${critical
          ? "bg-[var(--theme-error)]/15 border border-[var(--theme-error)]/40 text-[var(--theme-error)]"
          : warning
            ? "bg-[var(--theme-warning)]/15 border border-[var(--theme-warning)]/40 text-[var(--theme-warning)]"
            : "bg-[var(--theme-bg-secondary)] border border-[var(--theme-border)] text-[var(--theme-text)]"
        }
      `}
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
      <span className="font-mono text-sm tabular-nums leading-none">
        {formatTime(displaySeconds)}
      </span>
    </div>
  );
}
