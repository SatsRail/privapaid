"use client";
import { useEffect, useRef, useState } from "react";
import type { PlaybackSession } from "@/lib/video/playback-contract";
import type { VideoPlayerHandle, QualityState } from "@/lib/video/browser-player";
import { useLocale } from "@/i18n/useLocale";
export default function SegmentedVideoPlayer({ mediaId, initial }: { mediaId: string; initial?: { session: PlaybackSession; requestedAt: number } }) {
  const { t } = useLocale();
  const video = useRef<HTMLVideoElement>(null), handle = useRef<VideoPlayerHandle | undefined>(undefined);
  const [state, setState] = useState("loading"), [generation, setGeneration] = useState(0);
  const [quality, setQuality] = useState<QualityState>({ automatic: true, options: [] });
  const initialRef = useRef(initial);
  const resume = useRef<{ time: number; version?: string }>({ time: 0, version: initial?.session.version });
  useEffect(() => {
    let cancelled = false;
    let current: VideoPlayerHandle | undefined;
    void import("@/lib/video/browser-player").then(({ createVideoPlayer }) => {
      if (cancelled || !video.current) return;
      const player = createVideoPlayer(video.current, mediaId, s => { if (!cancelled) setState(s); }, generation === 0 ? initialRef.current : undefined, resume.current,
        q => { if (!cancelled) setQuality(q); });
      current = player.handle; handle.current = current;
      void player.ready.catch(() => { if (!cancelled) setState("error"); });
    }).catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; handle.current = undefined; void current?.destroy(); };
  }, [mediaId, generation]);
  const messages: Record<string, string> = {
    loading: t("viewer.video_playback.loading"), retrying: t("viewer.video_playback.retrying"),
    expired: t("viewer.video_playback.expired"), denied: t("viewer.video_playback.denied"),
    unsupported: t("viewer.video_playback.unsupported"), error: t("viewer.video_playback.error"),
  };
  return <div className="mb-6">
    <video key={`${mediaId}:${generation}`} ref={video} controls playsInline preload="none" aria-label={t("viewer.video_playback.label")} className="w-full rounded-lg bg-black" />
    {quality.options.length > 1 && <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
      <label>{t("viewer.video_playback.quality")} <select className="ml-2 rounded border bg-[var(--theme-bg)] p-2"
        value={quality.automatic ? "auto" : quality.activeId ?? "auto"} onChange={e => handle.current?.quality(e.target.value === "auto" ? "auto" : Number(e.target.value))}>
        <option value="auto">{t("viewer.video_playback.auto")}</option>
        {quality.options.map(q => <option key={q.id} value={q.id}>{q.height}p</option>)}
      </select></label>
      <span className="text-[var(--theme-text-secondary)]">{t("viewer.video_playback.quality_hint")}</span>
    </div>}
    {messages[state] && <div role="status" className="mt-3 text-sm">
      {messages[state]}
      {state === "error" && <button className="ml-3 underline" onClick={() => {
        resume.current = { time: video.current?.currentTime || resume.current.time, version: handle.current?.version() || resume.current.version };
        setState("loading"); setGeneration(g => g + 1);
      }}>{t("viewer.video_playback.retry")}</button>}
    </div>}
  </div>;
}
