import { ADAPTIVE_PROFILE, LEGACY_PROFILE, qualityLadder } from "./quality";
import { IngestionError } from "./ingestion-errors";
import { safeInputArgs } from "./process";
import type { SourceInfo } from "./validation";
export function encodingArgs(source: SourceInfo, input: string, output: string, segment: number, threads: number, profile = ADAPTIVE_PROFILE) {
  if (![ADAPTIVE_PROFILE, LEGACY_PROFILE].includes(profile) || ![4, 10].includes(segment)) throw new IngestionError("OUTPUT_INVALID");
  const ladder = qualityLadder(source.width, source.height);
  const qualities = profile === LEGACY_PROFILE ? [ladder.at(-1)!] : ladder;
  const filters = `[0:v:0]fps=30,setpts=PTS-STARTPTS,split=${qualities.length}${qualities.map((_, i) => `[s${i}]`).join("")};` +
    qualities.map((q, i) => `[s${i}]scale=${q.width}:${q.height}[v${i}]`).join(";");
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-max_alloc", "134217728", "-threads", String(threads),
    ...safeInputArgs, "-i", input, "-filter_complex_threads", "1", "-filter_complex", filters,
    ...qualities.flatMap((_, i) => ["-map", `[v${i}]`]), ...(source.audio ? ["-map", "0:a:0"] : []),
    "-map_metadata", "-1", "-map_chapters", "-1", "-c:v", "libx264", "-threads", String(threads),
    "-preset", "veryfast", "-pix_fmt", "yuv420p", "-profile:v", "main", "-level:v", "3.1",
    "-g", String(segment * 30), "-keyint_min", String(segment * 30), "-sc_threshold", "0", "-bf", "0",
    ...(profile === LEGACY_PROFILE ? ["-crf", "23", "-maxrate", "4M", "-bufsize", "8M"] :
      qualities.flatMap((q, i) => [`-b:v:${i}`, String(q.bitrate), `-maxrate:v:${i}`, String(q.maxrate), `-bufsize:v:${i}`, String(q.maxrate * 2)])),
    ...(source.audio ? ["-af", "aresample=48000:async=1:first_pts=0,apad", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"] : []),
    "-t", String(source.duration), "-progress", "pipe:1", "-nostats", "-f", "dash", "-seg_duration", String(segment),
    "-use_template", "1", "-use_timeline", "1", "-adaptation_sets", source.audio ? "id=0,streams=v id=1,streams=a" : "id=0,streams=v",
    "-init_seg_name", "init-$RepresentationID$.mp4", "-media_seg_name", "segment-$RepresentationID$-$Number%05d$.m4s",
    "-method", "PUT", "-timeout", "30", output];
}
