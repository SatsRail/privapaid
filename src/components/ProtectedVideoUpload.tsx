"use client";
import { useEffect, useRef, useState } from "react";
import { protectedVideoId } from "@/lib/protected-video-reference";

export default function ProtectedVideoUpload({ source, onUploaded, onBusy }: {
  source: string;
  onUploaded: (source: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const active = useRef<XMLHttpRequest | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function upload(file: File) {
    if (file.size > 512 * 1024 * 1024) { setMessage("Maximum video size is 512 MB."); return; }
    setBusy(true);
    onBusy(true);
    setProgress(0);
    setMessage("Uploading video… Keep this page open.");
    const xhr = new XMLHttpRequest();
    active.current = xhr;
    try {
      const reference = await new Promise<string>((resolve, reject) => {
        xhr.open("POST", "/api/admin/videos");
        xhr.setRequestHeader("Content-Type", "video/mp4");
        xhr.timeout = 15 * 60 * 1000;
        xhr.upload.onprogress = event => {
          if (!event.lengthComputable) return;
          const percent = Math.round(event.loaded / event.total * 100);
          setProgress(percent);
          if (percent === 100) setMessage("Upload received. Checking video format…");
        };
        xhr.onload = () => {
          try {
            const result = JSON.parse(xhr.responseText);
            if (xhr.status < 200 || xhr.status >= 300) throw new Error(result.error || "Upload failed. Please retry.");
            if (!protectedVideoId(result.source_url)) throw new Error("The server returned an invalid video reference.");
            resolve(result.source_url);
          } catch (error) { reject(error); }
        };
        xhr.onerror = () => reject(new Error("Connection lost. Your existing video is unchanged; retry the upload."));
        xhr.onabort = () => reject(new Error("Upload cancelled. Your existing video is unchanged."));
        xhr.ontimeout = () => reject(new Error("Upload timed out. Please retry on a stable connection."));
        xhr.send(file);
      });
      onUploaded(reference);
      setMessage("Upload complete. Save this media to use the protected video.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed. Please retry.");
    } finally {
      active.current = null;
      setBusy(false);
      onBusy(false);
    }
  }

  return <div className="space-y-2 text-sm">
    <label className="block font-medium">Upload protected video
      <input className="mt-2 block w-full" type="file" accept="video/mp4,.mp4" disabled={busy} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void upload(file);
      }} />
    </label>
    <p className="text-[var(--theme-text-secondary)]">H.264 MP4 with optional AAC audio, up to 512 MB. Owner access and configured private storage required.</p>
    {busy && <div className="flex items-center gap-3">
      <progress aria-label="Video upload progress" max={100} value={progress} />
      <span>{progress}%</span>
      <button type="button" className="rounded border px-3 py-1" onClick={() => active.current?.abort()}>Cancel upload</button>
    </div>}
    {protectedVideoId(source) && <p>Protected video selected. Saving preserves the current product and price.</p>}
    <p role="status">{message}</p>
  </div>;
}
