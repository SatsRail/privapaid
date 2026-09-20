"use client";
import { useEffect, useRef, useState } from "react";

export default function ProtectedVideoPlayer({ mediaId, ownerPreview = false }: { mediaId: string; ownerPreview?: boolean }) {
  const url = `/api/${ownerPreview ? "admin/" : ""}media/${encodeURIComponent(mediaId)}/video`;
  const video = useRef<HTMLVideoElement>(null);
  const probe = useRef<AbortController | null>(null);
  const position = useRef(0);
  const [failure, setFailure] = useState<"access" | "busy" | "unavailable" | null>(null);
  useEffect(() => () => probe.current?.abort(), [url]);

  async function diagnose() {
    probe.current?.abort();
    const controller = new AbortController();
    probe.current = controller;
    try {
      const result = await fetch(url, { method: "HEAD", cache: "no-store", signal: controller.signal });
      if (!controller.signal.aborted) setFailure([401, 402, 403].includes(result.status) ? "access" : result.status === 429 ? "busy" : "unavailable");
    } catch {
      if (!controller.signal.aborted) setFailure("unavailable");
    }
  }

  return <div className="space-y-3">
    <video ref={video} src={url} controls playsInline preload="metadata" className="w-full rounded-lg"
      onTimeUpdate={() => { if (video.current) position.current = video.current.currentTime; }}
      onLoadedMetadata={() => { if (video.current && position.current > 0) video.current.currentTime = Math.min(position.current, video.current.duration || position.current); }}
      onError={() => void diagnose()} />
    {failure && <div role="alert" className="space-y-2 rounded border border-[var(--theme-border)] p-3">
      <p>{failure === "access" ? "Playback access is missing or expired. Check your purchase before paying again." : failure === "busy" ? "The video server is busy. Wait a moment, then retry." : "Playback is temporarily unavailable. Retry without making another payment."}</p>
      <button type="button" className="rounded border px-3 py-1" onClick={() => {
        if (failure === "access") { window.location.reload(); return; }
        setFailure(null);
        video.current?.load();
      }}>{failure === "access" ? "Check access" : "Retry playback"}</button>
    </div>}
  </div>;
}
