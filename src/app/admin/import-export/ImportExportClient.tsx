"use client";

import { useState, useRef, useCallback } from "react";
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
    categories: EntityResults;
    channels: EntityResults;
    media: EntityResults;
    channel_products?: EntityResults;
  };
}

interface ImportPayload {
  version: string;
  categories?: Array<{ slug: string; name: string; position?: number; active?: boolean }>;
  channels?: Array<{
    slug: string;
    name: string;
    media?: Array<{ name: string; source_url: string; product?: unknown; [key: string]: unknown }>;
    product?: unknown;
    [key: string]: unknown;
  }>;
}

interface ProgressEvent {
  phase: string;
  item: string;
  status: "processing" | "done" | "error";
  error?: string;
  completed: number;
  total: number;
}

interface LogEntry {
  phase: string;
  item: string;
  status: "done" | "error";
  error?: string;
  timestamp: number;
}

const PHASE_LABELS: Record<string, string> = {
  categories: "Categories",
  channels: "Channels",
  media: "Media & Products",
  channel_products: "Channel Access",
};

const PHASE_ORDER = ["categories", "channels", "media", "channel_products"] as const;

export default function ImportExportClient() {
  const [exporting, setExporting] = useState(false);
  const [importFile, setImportFile] = useState<ImportPayload | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState<ImportResults | null>(null);
  const [importError, setImportError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Progress state
  const [currentPhase, setCurrentPhase] = useState("");
  const [currentItem, setCurrentItem] = useState("");
  const [detail, setDetail] = useState("");
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [log, setLog] = useState<LogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [...prev, entry]);
  }, []);

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch("/api/admin/export");
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disposition = res.headers.get("Content-Disposition");
      const match = disposition?.match(/filename="(.+)"/);
      a.download = match?.[1] || "privapaid-export.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

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
      phase: () => { setCurrentPhase(data.phase as string); setCurrentItem(""); setDetail(""); },
      status: () => { setCurrentItem(data.item as string); setDetail(data.detail as string); },
      progress: () => {
        const p = data as unknown as ProgressEvent;
        setCurrentItem(p.item);
        setDetail("");
        setProgress({ completed: p.completed, total: p.total });
        if (p.status !== "processing") {
          addLog({
            phase: p.phase, item: p.item,
            status: p.status as "done" | "error",
            error: p.error, timestamp: Date.now(),
          });
        }
      },
      complete: () => { setImportResults(data as unknown as ImportResults); },
      error: () => { setImportError(data.error as string); },
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
    setCurrentPhase("");
    setCurrentItem("");
    setDetail("");

    try {
      const res = await fetch("/api/admin/import", {
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
      setCurrentPhase("");
      setCurrentItem("");
      setDetail("");
    }
  }

  function renderSummary(data: ImportPayload) {
    const catCount = data.categories?.length || 0;
    const chCount = data.channels?.length || 0;
    const mediaCount =
      data.channels?.reduce((sum, ch) => sum + (ch.media?.length || 0), 0) || 0;
    const productCount =
      data.channels?.reduce(
        (sum, ch) =>
          sum + (ch.media?.filter((m) => m.product)?.length || 0),
        0
      ) || 0;
    const channelProductCount =
      data.channels?.filter((ch) => ch.product)?.length || 0;

    return (
      <div className="flex flex-wrap gap-4 text-sm">
        <div className="flex items-center gap-1.5">
          <strong>{catCount}</strong>
          <span className="text-zinc-400">categories</span>
        </div>
        <div className="flex items-center gap-1.5">
          <strong>{chCount}</strong>
          <span className="text-zinc-400">channels</span>
        </div>
        <div className="flex items-center gap-1.5">
          <strong>{mediaCount}</strong>
          <span className="text-zinc-400">media items</span>
        </div>
        {productCount > 0 && (
          <div className="flex items-center gap-1.5">
            <strong>{productCount}</strong>
            <span className="text-zinc-400">products</span>
          </div>
        )}
        {channelProductCount > 0 && (
          <div className="flex items-center gap-1.5">
            <strong>{channelProductCount}</strong>
            <span className="text-zinc-400">channel access</span>
          </div>
        )}
      </div>
    );
  }

  function renderProgress() {
    const pct = progress.total > 0
      ? Math.round((progress.completed / progress.total) * 100)
      : 0;

    const errorCount = log.filter((l) => l.status === "error").length;

    return (
      <div className="space-y-3 rounded-md border border-zinc-700 bg-black p-4">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white">
              {currentPhase
                ? `Importing ${PHASE_LABELS[currentPhase] || currentPhase}...`
                : "Starting import..."}
            </p>
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

        {/* Phase dots */}
        <div className="flex items-center justify-center gap-6 text-xs">
          {PHASE_ORDER.map((phase) => {
            const phaseIndex = PHASE_ORDER.indexOf(phase);
            const currentIndex = currentPhase
              ? PHASE_ORDER.indexOf(currentPhase as typeof PHASE_ORDER[number])
              : pct === 100 ? PHASE_ORDER.length : -1;
            const isActive = currentPhase === phase;
            const isDone = phaseIndex < currentIndex;

            return (
              <div key={phase} className="flex items-center gap-1.5">
                <div
                  className={`h-2 w-2 rounded-full transition-colors ${
                    isDone
                      ? "bg-emerald-400"
                      : isActive
                        ? "bg-emerald-400 animate-pulse"
                        : "bg-zinc-700"
                  }`}
                />
                <span className={isDone || isActive ? "text-zinc-200" : "text-zinc-600"}>
                  {PHASE_LABELS[phase]}
                </span>
              </div>
            );
          })}
        </div>

        {log.length > 0 && (
          <div className="max-h-36 overflow-y-auto rounded border border-zinc-800 bg-black/40 p-2 font-mono text-[11px] leading-relaxed">
            {log.slice(-20).map((entry, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className={entry.status === "error" ? "text-red-400" : "text-emerald-500"}>
                  {entry.status === "error" ? "x" : "+"}
                </span>
                <span className="text-zinc-500">[{PHASE_LABELS[entry.phase]?.slice(0, 3) || "???"}]</span>
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
    );
  }

  function renderResults(results: ImportResults) {
    const { categories, channels, media, channel_products } = results.results;
    const emptyResults: EntityResults = { created: 0, updated: 0, errors: [] };
    const cp = channel_products || emptyResults;
    const allErrors = [
      ...categories.errors,
      ...channels.errors,
      ...media.errors,
      ...cp.errors,
    ];

    const totalCreated = categories.created + channels.created + media.created + cp.created;
    const totalUpdated = categories.updated + channels.updated + media.updated + cp.updated;

    return (
      <div className="space-y-3 rounded-md border border-zinc-700 bg-black p-4">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
              allErrors.length === 0
                ? "bg-emerald-600/20 text-emerald-400"
                : "bg-yellow-600/20 text-yellow-400"
            }`}
          >
            {allErrors.length === 0 ? "+" : "!"}
          </div>
          <div>
            <h3 className={`text-sm font-semibold ${allErrors.length === 0 ? "text-emerald-400" : "text-yellow-400"}`}>
              {allErrors.length === 0 ? "Import Complete" : "Import Completed with Errors"}
            </h3>
            <p className="text-xs text-[var(--theme-text-secondary)]">
              {totalCreated} created, {totalUpdated} updated
              {allErrors.length > 0 && `, ${allErrors.length} error${allErrors.length !== 1 ? "s" : ""}`}
            </p>
          </div>
        </div>

        {/* Per-entity breakdown */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {([
            { label: "Categories", data: categories },
            { label: "Channels", data: channels },
            { label: "Media", data: media },
            { label: "Channel Access", data: cp },
          ] as const).map(({ label, data }) => (
            <div key={label} className="rounded border border-zinc-700 bg-black p-2.5 text-xs">
              <p className="mb-1 text-zinc-400">{label}</p>
              <div className="flex gap-2">
                {data.created > 0 && <span className="text-emerald-400">+{data.created}</span>}
                {data.updated > 0 && <span className="text-blue-400">~{data.updated}</span>}
                {data.errors.length > 0 && <span className="text-red-400">{data.errors.length} err</span>}
                {data.created === 0 && data.updated === 0 && data.errors.length === 0 && (
                  <span className="text-zinc-600">--</span>
                )}
              </div>
            </div>
          ))}
        </div>

        {allErrors.length > 0 && (
          <div className="max-h-48 overflow-y-auto rounded border border-zinc-700 bg-black p-2 font-mono text-[11px] leading-relaxed">
            {allErrors.map((err, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="text-red-400 shrink-0">x</span>
                <span className="text-zinc-500 shrink-0">[{err.entity}]</span>
                <span className="text-red-300">{err.name}</span>
                <span className="text-red-500"> -- {err.error}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {/* --- Export --- */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Export</h2>
        <p className="mb-4 text-sm text-[var(--theme-text-secondary)]">
          Download all categories, channels, and media as a JSON file. Edit it
          externally and re-import to update your content.
        </p>
        <Button onClick={handleExport} disabled={exporting}>
          {exporting ? "Exporting..." : "Export All Content"}
        </Button>
      </section>

      {/* --- Import --- */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Import</h2>
        <p className="mb-4 text-sm text-[var(--theme-text-secondary)]">
          Upload a JSON file in the export format. Existing content is matched
          by slug and updated; new entries are created. Products are created or
          updated on SatsRail automatically.{" "}
          <a
            href="/import-sample.json"
            download="import-sample.json"
            className="text-[var(--theme-primary)] hover:underline"
          >
            Download sample JSON
          </a>
        </p>

        <div className="space-y-4">
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
              className="rounded-md border border-zinc-500 bg-zinc-800 px-4 py-2 text-sm font-medium text-white hover:border-zinc-400 hover:bg-zinc-700 disabled:opacity-50"
            >
              {importFileName || "Choose JSON file..."}
            </button>
          </div>

          {importFile && !importing && !importResults && (
            <div className="space-y-3 rounded-lg border border-zinc-700 bg-black p-4">
              <h3 className="text-sm font-medium">Preview</h3>
              {renderSummary(importFile)}
              <button
                onClick={handleImport}
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
              >
                Import
              </button>
            </div>
          )}

          {importing && renderProgress()}

          {importError && !importing && (
            <p className="text-sm text-red-400">{importError}</p>
          )}

          {importResults && !importing && renderResults(importResults)}
        </div>
      </section>
    </div>
  );
}
