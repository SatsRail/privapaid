"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";

interface LogEntry {
  item: string;
  status: "done" | "error";
  error?: string;
  timestamp: number;
}

export default function ChannelSamplerPreview({ channelId }: { channelId: string }) {
  const router = useRouter();
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [showJson, setShowJson] = useState(false);
  const [samplerJson, setSamplerJson] = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [...prev, entry]);
  }, []);

  async function loadSamplerJson() {
    if (samplerJson) {
      setShowJson(!showJson);
      return;
    }
    try {
      const res = await fetch("/channel-sampler.json");
      const text = await res.text();
      setSamplerJson(text);
      setShowJson(true);
    } catch {
      setError("Failed to load sampler JSON");
    }
  }

  async function handleImport() {
    setImporting(true);
    setError("");
    setDone(false);
    setLog([]);
    setProgress({ completed: 0, total: 0 });

    try {
      const samplerRes = await fetch("/channel-sampler.json");
      const payload = await samplerRes.json();

      const res = await fetch(`/api/admin/channels/${channelId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok && !res.headers.get("content-type")?.includes("text/event-stream")) {
        const json = await res.json();
        throw new Error(json.error || "Import failed");
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("Streaming not supported");

      const decoder = new TextDecoder();
      let buffer = "";
      let eventType = "";

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
            continue;
          }
          if (!line.startsWith("data: ") || !eventType) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (eventType === "progress") {
              setProgress({ completed: data.completed, total: data.total });
              addLog({ item: data.item, status: data.status, error: data.error, timestamp: Date.now() });
            } else if (eventType === "complete") {
              setDone(true);
            } else if (eventType === "error") {
              setError(data.error);
            }
          } catch {
            // skip malformed JSON
          }
          eventType = "";
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  const errorCount = log.filter((l) => l.status === "error").length;

  if (done) {
    return (
      <div className="mt-4 rounded-lg border border-emerald-600/30 bg-emerald-600/5 p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600/20">
            <span className="text-base">&#10003;</span>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-emerald-400">Sampler Imported</h4>
            <p className="text-xs text-[var(--theme-text-secondary)]">
              {progress.completed} items processed{errorCount > 0 ? `, ${errorCount} error${errorCount !== 1 ? "s" : ""}` : ""}
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => router.refresh()}>
          Refresh Page
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Channel Sampler</h3>
        <p className="mt-1 text-xs text-[var(--theme-text-secondary)]">
          This channel has no media yet. Import the sampler to test all supported media types
          (video, audio, podcast, article, photo set) with thumbnails and products.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={handleImport}
          disabled={importing}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {importing ? "Importing..." : "Import Sampler"}
        </button>
        <Button
          variant="outline"
          size="sm"
          onClick={loadSamplerJson}
          disabled={importing}
        >
          {showJson ? "Hide JSON" : "View JSON"}
        </Button>
        <a
          href="/channel-sampler.json"
          download="channel-sampler.json"
          className="text-xs text-[var(--theme-primary)] hover:underline"
        >
          Download
        </a>
      </div>

      {/* JSON preview */}
      {showJson && samplerJson && (
        <div className="max-h-80 overflow-auto rounded-md border border-[var(--theme-border)] bg-black/40 p-3">
          <pre className="font-mono text-[11px] leading-relaxed text-zinc-300 whitespace-pre">
            {samplerJson}
          </pre>
        </div>
      )}

      {/* Progress */}
      {importing && (
        <div className="space-y-3 rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Importing sampler...</p>
            <div className="text-right">
              <p className="text-lg font-bold tabular-nums text-emerald-400">{pct}%</p>
              <p className="text-xs text-zinc-500 tabular-nums">{progress.completed}/{progress.total}</p>
            </div>
          </div>
          <div className="relative h-2 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          {log.length > 0 && (
            <div className="max-h-36 overflow-y-auto rounded border border-zinc-800 bg-black/40 p-2 font-mono text-[11px] leading-relaxed">
              {log.slice(-20).map((entry, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className={entry.status === "error" ? "text-red-400" : "text-emerald-500"}>
                    {entry.status === "error" ? "\u2717" : "\u2713"}
                  </span>
                  <span className={entry.status === "error" ? "text-red-300" : "text-zinc-300"}>
                    {entry.item}
                  </span>
                  {entry.error && <span className="text-red-500"> &mdash; {entry.error}</span>}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && !importing && (
        <p className="text-sm text-red-400">{error}</p>
      )}
    </div>
  );
}
