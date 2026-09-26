"use client";
import { useEffect, useRef, useState } from "react";
import { fileFingerprint, transferFile, uploadRequest, type UploadStatus } from "@/lib/video/upload-client";
import { ingestionMessages, type IngestionCode } from "@/lib/video/ingestion-errors";
import { videoEstimate, SEGMENT_PRESETS } from "@/lib/video/quality";
import { localVideoInfo } from "@/lib/video/file-info";
import VideoCapacity, { gib } from "@/components/VideoCapacity";
export default function VideoUpload({ mediaId, products }: { mediaId: string; products: { id: string; name: string }[] }) {
  const [file, setFile] = useState<File | null>(null), [productId, setProductId] = useState(products[0]?.id || "");
  const [segment, setSegment] = useState("4"), [upload, setUpload] = useState<UploadStatus | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null), creation = useRef<string | null>(null);
  const [info, setInfo] = useState<{ duration: number; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    localVideoInfo(file, controller.signal).then(value => { if (!controller.signal.aborted) setInfo(value); }).catch(() => {});
    return () => controller.abort();
  }, [file]);
  useEffect(() => {
    const controller = new AbortController();
    uploadRequest(`/uploads?mediaId=${encodeURIComponent(mediaId)}`, { signal: controller.signal })
      .then(value => setUpload(value.items[0] || null)).catch(err => { if (!controller.signal.aborted) setError(err.message); }).finally(() => setLoading(false));
    return () => { controller.abort(); operation.current?.abort(); };
  }, [mediaId]);
  useEffect(() => {
    if (!upload || !["queued", "processing"].includes(upload.status)) return;
    const controller = new AbortController();
    const timer = setInterval(() => { uploadRequest(`/uploads/${upload.id}`, { signal: controller.signal }).then(setUpload)
      .catch(err => { if (!controller.signal.aborted) setError(err.message); }); }, 3000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [upload?.id, upload?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError("");
    try { await action(controller.signal); }
    catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Upload interrupted. Resume with the original file."); }
    finally { operation.current = null; setBusy(false); }
  }
  async function send(signal: AbortSignal) {
    if (!file) throw new Error("Choose an MP4 file first.");
    if (file.size > 10 * 1024 ** 3 || file.size < 12) throw new Error(ingestionMessages.INVALID_UPLOAD);
    let current = upload;
    if (current?.status === "uploading") current = await uploadRequest(`/uploads/${current.id}/resume`, { method: "POST", signal });
    else {
      creation.current ||= crypto.randomUUID();
      current = await uploadRequest("/uploads", { method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId, productId, bytes: file.size, segmentSeconds: Number(segment), clientFingerprint: await fileFingerprint(file), idempotencyKey: creation.current }) });
    }
    setUpload(current);
    setUpload(await transferFile(file, current!, signal, setUpload)); creation.current = null;
  }
  const pending = upload && ["uploading", "queued", "processing"].includes(upload.status);
  const percent = upload ? upload.status === "uploading" ? Math.floor(upload.receivedBytes * 100 / upload.bytes) : upload.progress : 0;
  const button = "rounded-lg border border-[var(--theme-border)] px-4 py-2 disabled:opacity-40";
  let estimate: ReturnType<typeof videoEstimate> = null;
  try { if (info) estimate = videoEstimate(info.duration, info.width, info.height, upload?.status === "uploading" ? upload.segmentSeconds || Number(segment) : Number(segment)); } catch { /* Worker validates unsupported metadata. */ }
  return <div className="space-y-5">
    <VideoCapacity />
    {!products.length && <p role="alert">Associate an active paid product on the media edit page before uploading.</p>}
    {(!pending || upload?.status === "uploading") && <>
      <label className="block">MP4 file<input type="file" accept="video/mp4,.mp4" disabled={busy || loading} onChange={event => { setFile(event.target.files?.[0] || null); setInfo(null); if (!upload) creation.current = null; }} className="mt-2 block w-full" /></label>
      {upload?.status === "uploading" ? <p>Reselect the original file to resume from {Math.floor(upload.receivedBytes / 1024 ** 2)} MiB. Upload expires {new Date(upload.expiresAt).toLocaleString()}.</p> : <>
        <label className="block">Access product<select value={productId} disabled={busy} onChange={e => { setProductId(e.target.value); creation.current = null; }} className="ml-3 rounded border p-2">{products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="block">Playback segment duration<select value={segment} disabled={busy} onChange={e => { setSegment(e.target.value); creation.current = null; }} className="ml-3 rounded border p-2">{SEGMENT_PRESETS.map(n => <option key={n} value={n}>{n} seconds{n === 4 ? " (recommended)" : ""}</option>)}</select></label>
        <p className="text-sm text-[var(--theme-text-secondary)]">4 seconds responds faster to seeks and connection changes. 10 seconds makes fewer media requests, but needs more download time per segment. Both play continuously. Segment duration does not change SatsRail renewal calls. Changing it requires a new upload/version.</p>
      </>}
      {estimate && <div className="rounded border border-[var(--theme-border)] p-3 text-sm" aria-live="polite">
        <p>Estimated qualities: {estimate.qualities.map(q => `${q.width}×${q.height}`).join(", ")}</p>
        <p>About {estimate.viewerRequests.toLocaleString()} media requests per complete view · {estimate.storedObjects.toLocaleString()} stored objects · {gib(estimate.outputBytes)} GiB prepared output</p>
        <p>Encodes {estimate.qualities.length} video quality level(s), about {estimate.pixelWork.toFixed(1)}× the pixels of the highest quality alone. This is not a processing-time estimate.</p>
        <p className="mt-1 text-[var(--theme-text-secondary)]">Estimates assume audio and target bitrates. Seeks, retries and quality changes add requests; source files and retained versions add storage. The worker confirms the final dimensions.</p>
      </div>}
    </>}
    {upload && <div aria-live="polite"><p>{upload.status === "ready" ? "Video prepared successfully" : upload.status === "uploading" ? `Uploaded ${percent}%${busy ? "" : " · paused"}` : `${upload.status} · ${percent}%`}</p><progress aria-label="Video progress" max="100" value={percent} className="w-full" /></div>}
    {upload?.status === "ready" && <p className="text-sm">{gib(upload.encryptedBytes || "0")} GiB prepared · {upload.objectCount || 0} objects · {upload.segmentSeconds || segment}-second segments · {upload.published ? "Published" : "Prepared version retained"}</p>}
    {(error || upload?.error) && <p role="alert" className="text-red-400">{error || ingestionMessages[upload?.error as IngestionCode] || "Processing was interrupted. Retry when the worker is available."}</p>}
    <div className="flex flex-wrap gap-3">
      {(!pending || upload?.status === "uploading") && <button className={button} disabled={busy || loading || !file || !productId} onClick={() => run(send)}>{upload?.status === "uploading" ? "Resume upload" : "Upload and prepare"}</button>}
      {busy && <button className={button} onClick={() => operation.current?.abort()}>Pause transfer</button>}
      {pending && <button className={button} disabled={busy} onClick={() => run(async signal => { setUpload(await uploadRequest(`/uploads/${upload!.id}`, { method: "DELETE", signal })); creation.current = null; })}>Cancel upload</button>}
      {upload?.canRetry && <button className={button} disabled={busy} onClick={() => run(async signal => { setUpload(await uploadRequest(`/uploads/${upload!.id}/retry`, { method: "POST", signal })); })}>Retry processing</button>}
    </div>
  </div>;
}
