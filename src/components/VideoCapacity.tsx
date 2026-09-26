"use client";
import { useEffect, useState } from "react";
import { uploadRequest } from "@/lib/video/upload-client";
import type { VideoCapacity as Capacity } from "@/lib/video/capacity";
export function gib(value: string | number) { return (Number(value) / 1024 ** 3).toFixed(2); }
export default function VideoCapacity() {
  const [data, setData] = useState<Capacity | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const result = await uploadRequest("/capacity", { signal: controller.signal }); if (!controller.signal.aborted) { setData(result); setFailed(false); } }
      catch { if (!controller.signal.aborted) setFailed(true); }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 15000); }
    }
    void refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const readinessText: Record<string, string> = { VIDEO_WORKER_MISSING: "Processing worker offline", VIDEO_STORAGE_UNAVAILABLE: "Video storage unavailable", VIDEO_STORAGE_PROBE_REQUIRED: "Storage verification needed", VIDEO_DATABASE_MIGRATION_REQUIRED: "Video database setup needed" };
  return <section aria-label="Video processing capacity" className="rounded-xl border border-[var(--theme-border)] p-4 text-sm">
    <h2 className="font-semibold">Processing and storage</h2>
    {failed ? <p role="status">Capacity information is temporarily unavailable.</p> : !data ? <p>Checking capacity…</p> : <>
      <p role="status">{data.readiness.ready ? "Ready to prepare videos" : readinessText[data.readiness.code] || "Video setup needed"} · {data.readiness.workerCount} worker(s)</p>
      <p>{data.processing} processing · {data.queued} queued · {data.pending}/{data.maxPending} upload/processing slots occupied</p>
      <p>{gib(data.encryptedOutputBytes)} GiB of prepared output · {gib(data.reservedBytes)}/{gib(data.storageBudgetBytes)} GiB reserved</p>
      <p className="mt-2 text-[var(--theme-text-secondary)]">Reservations include source uploads and retry allowance. Prepared output is not the total storage bill. Retained versions continue to occupy space.</p>
    </>}
  </section>;
}
