"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";

interface ImportError {
  entity: string;
  name: string;
  error: string;
}

interface EntityResults {
  created: number;
  updated: number;
  errors: ImportError[];
}

interface ImportResults {
  success: boolean;
  results: {
    media: EntityResults;
  };
}

interface ChannelImportPayload {
  version: string;
  media?: Array<{
    name: string;
    source_url: string;
    product?: unknown;
    [key: string]: unknown;
  }>;
}

interface LogEntry {
  item: string;
  status: "done" | "error";
  error?: string;
  timestamp: number;
}

interface ChannelImportSectionProps {
  channelId: string;
}

export default function ChannelImportSection({
  channelId,
}: ChannelImportSectionProps) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [importFile, setImportFile] = useState<ChannelImportPayload | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState<ImportResults | null>(null);
  const [importError, setImportError] = useState("");
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [currentItem, setCurrentItem] = useState("");
  const [detail, setDetail] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [...prev, entry]);
  }, []);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportError("");
    setImportResults(null);
    setImportFileName(file.name);
    setLog([]);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (data.version !== "1.0") {
          setImportError('Invalid file: version must be "1.0"');
          setImportFile(null);
          return;
        }
        if (!Array.isArray(data.media) || data.media.length === 0) {
          setImportError("Invalid file: media array is required and must not be empty");
          setImportFile(null);
          return;
        }
        setImportFile(data);
      } catch {
        setImportError("Invalid JSON file");
        setImportFile(null);
      }
    };
    reader.readAsText(file);
  }

  function handleSSEEvent(eventType: string, data: Record<string, unknown>) {
    const handlers: Record<string, () => void> = {
      phase: () => {
        setCurrentItem("");
        setDetail("");
      },
      status: () => {
        setCurrentItem(data.item as string);
        setDetail(data.detail as string);
      },
      progress: () => {
        const p = data as { item: string; status: string; error?: string; completed: number; total: number };
        setCurrentItem(p.item);
        setDetail("");
        setProgress({ completed: p.completed, total: p.total });
        if (p.status !== "processing") {
          addLog({
            item: p.item,
            status: p.status as "done" | "error",
            error: p.error,
            timestamp: Date.now(),
          });
        }
      },
      complete: () => {
        setImportResults(data as unknown as ImportResults);
      },
      error: () => {
        setImportError(data.error as string);
      },
    };
    handlers[eventType]?.();
  }

  function parseSSELines(lines: string[]) {
    let eventType = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7);
        continue;
      }
      if (!line.startsWith("data: ") || !eventType) continue;
      try {
        handleSSEEvent(eventType, JSON.parse(line.slice(6)));
      } catch {
        // skip malformed JSON
      }
      eventType = "";
    }
  }

  async function readSSEStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      parseSSELines(lines);
    }
  }

  async function handleImport() {
    if (!importFile) return;
    setImporting(true);
    setImportError("");
    setImportResults(null);
    setLog([]);
    setProgress({ completed: 0, total: 0 });
    setCurrentItem("");
    setDetail("");

    try {
      const res = await fetch(`/api/admin/channels/${channelId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(importFile),
      });

      if (!res.ok && !res.headers.get("content-type")?.includes("text/event-stream")) {
        const json = await res.json();
        throw new Error(json.error || "Import failed");
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("Streaming not supported");

      await readSSEStream(reader);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
      setCurrentItem("");
      setDetail("");
    }
  }

  function reset() {
    setImportFile(null);
    setImportFileName("");
    setImportResults(null);
    setImportError("");
    setLog([]);
    setProgress({ completed: 0, total: 0 });
    setDetail("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  if (!expanded) {
    return (
      <div className="mb-6 flex items-center gap-3">
        <button
          onClick={() => setExpanded(true)}
          className="rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] px-3 py-1.5 text-sm hover:opacity-80"
        >
          Import Media
        </button>
        <a
          href={`/api/admin/channels/${channelId}/export`}
          className="rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] px-3 py-1.5 text-sm hover:opacity-80"
        >
          Export Channel
        </a>
      </div>
    );
  }

  const mediaCount = importFile?.media?.length || 0;
  const productCount = importFile?.media?.filter((m) => m.product)?.length || 0;
  const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  const errorCount = log.filter((l) => l.status === "error").length;

  return (
    <div className="mb-6 space-y-4 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Import Media</h3>
        <div className="flex items-center gap-2">
          <a
            href={`/api/admin/channels/${channelId}/export`}
            className="text-xs text-[var(--theme-text-secondary)] hover:underline"
          >
            Export Channel
          </a>
          <a
            href="/channel-import-sample.json"
            download="channel-import-sample.json"
            className="text-xs text-[var(--theme-text-secondary)] hover:underline"
          >
            Sample JSON
          </a>
          <button
            onClick={() => { reset(); setExpanded(false); }}
            className="text-xs text-[var(--theme-text-secondary)] hover:underline"
          >
            Close
          </button>
        </div>
      </div>

      <p className="text-xs text-[var(--theme-text-secondary)]">
        Upload a JSON file with media items for this channel. Existing media is matched by ref or
        name and updated; new entries are created.
      </p>

      {/* File select */}
      <div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileSelect}
          className="hidden"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          className="rounded-md border border-zinc-500 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:border-zinc-400 hover:bg-zinc-700 disabled:opacity-50"
        >
          {importFileName || "Choose JSON file..."}
        </button>
      </div>

      {/* Preview */}
      {importFile && !importing && !importResults && (
        <div className="space-y-3 rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] p-3">
          <div className="flex flex-wrap gap-4 text-sm">
            <div className="flex items-center gap-1.5">
              <strong>{mediaCount}</strong>
              <span className="text-[var(--theme-text-secondary)]">media items</span>
            </div>
            {productCount > 0 && (
              <div className="flex items-center gap-1.5">
                <strong>{productCount}</strong>
                <span className="text-[var(--theme-text-secondary)]">products</span>
              </div>
            )}
          </div>
          <button
            onClick={handleImport}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
          >
            Import
          </button>
        </div>
      )}

      {/* Progress */}
      {importing && (
        <div className="space-y-3 rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] p-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white">Importing media...</p>
              {currentItem && (
                <p className="text-xs text-[var(--theme-text-secondary)] truncate max-w-md">
                  {currentItem}
                </p>
              )}
              {detail && (
                <p className="text-[11px] text-zinc-500 truncate max-w-md animate-pulse">
                  {detail}
                </p>
              )}
            </div>
            <div className="text-right shrink-0 ml-4">
              <p className="text-lg font-bold tabular-nums text-emerald-400">{pct}%</p>
              <p className="text-xs text-zinc-500 tabular-nums">
                {progress.completed}/{progress.total}
              </p>
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
                    {entry.status === "error" ? "x" : "+"}
                  </span>
                  <span className={entry.status === "error" ? "text-red-300" : "text-zinc-300"}>
                    {entry.item}
                  </span>
                  {entry.error && (
                    <span className="text-red-500"> -- {entry.error}</span>
                  )}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}

          {errorCount > 0 && (
            <p className="text-xs text-yellow-400">
              {errorCount} error{errorCount !== 1 ? "s" : ""} encountered -- import continues
            </p>
          )}
        </div>
      )}

      {/* Error */}
      {importError && !importing && (
        <p className="text-sm text-red-400">{importError}</p>
      )}

      {/* Results */}
      {importResults && !importing && (
        <div className="space-y-3 rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] p-4">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
                importResults.success
                  ? "bg-emerald-600/20 text-emerald-400"
                  : "bg-yellow-600/20 text-yellow-400"
              }`}
            >
              {importResults.success ? "+" : "!"}
            </div>
            <div>
              <h4
                className={`text-sm font-semibold ${
                  importResults.success ? "text-emerald-400" : "text-yellow-400"
                }`}
              >
                {importResults.success ? "Import Complete" : "Import Completed with Errors"}
              </h4>
              <p className="text-xs text-[var(--theme-text-secondary)]">
                {importResults.results.media.created} created,{" "}
                {importResults.results.media.updated} updated
                {importResults.results.media.errors.length > 0 &&
                  `, ${importResults.results.media.errors.length} error${
                    importResults.results.media.errors.length !== 1 ? "s" : ""
                  }`}
              </p>
            </div>
          </div>

          {importResults.results.media.errors.length > 0 && (
            <div className="max-h-48 overflow-y-auto rounded border border-zinc-800 bg-black/40 p-2 font-mono text-[11px] leading-relaxed">
              {importResults.results.media.errors.map((err, i) => (
                <div key={i} className="flex items-start gap-1.5 mb-1">
                  <span className="text-red-400 shrink-0">x</span>
                  <span className="text-red-300 shrink-0">{err.name}</span>
                  <span className="text-red-500 break-all"> -- {err.error}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                reset();
                router.refresh();
              }}
            >
              Refresh Page
            </Button>
            <Button variant="outline" size="sm" onClick={reset}>
              Import More
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
