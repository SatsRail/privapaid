import { IngestionError } from "./ingestion-errors";
import { mediaProcess, safeInputArgs } from "./process";
import type { IngestionConfig } from "./ingestion-config";
import type { MediaBridge } from "./bridge";
export type SourceInfo = { duration: number; audio: boolean };
export async function probeSource(url: string, config: IngestionConfig, signal: AbortSignal): Promise<SourceInfo> {
  const raw = await mediaProcess(config.ffprobe, ["-v", "error", "-max_alloc", "134217728", ...safeInputArgs,
    "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate:stream_disposition=attached_pic:format=duration,format_name", "-of", "json", url], { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  try {
    const info = JSON.parse(raw), streams = info.streams as { codec_type: string; codec_name: string; width: number; height: number; pix_fmt: string; avg_frame_rate: string; disposition?: { attached_pic?: number } }[];
    const video = streams.filter(s => s.codec_type === "video"), audio = streams.filter(s => s.codec_type === "audio");
    const duration = Number(info.format?.duration), [numerator, denominator] = (video[0]?.avg_frame_rate || "0/0").split("/").map(Number);
    const fps = numerator / denominator;
    if (video.length !== 1 || audio.length > 1 || streams.length !== video.length + audio.length ||
        video[0].codec_name !== "h264" || video[0].pix_fmt !== "yuv420p" || video[0].disposition?.attached_pic || audio.some(s => s.codec_name !== "aac") ||
        !Number.isFinite(fps) || fps <= 0 || fps > 60 || video[0].width < 16 || video[0].height < 16 || video[0].width > 3840 || video[0].height > 2160 ||
        !Number.isFinite(duration) || duration <= 0 || duration > config.maxDurationSeconds || !String(info.format.format_name).split(",").includes("mp4")) throw new Error();
    return { duration, audio: audio.length === 1 };
  } catch { throw new IngestionError("INVALID_VIDEO", 422); }
}
export function validateManifest(manifest: string, bridge: MediaBridge, source: SourceInfo) {
  if (!manifest.includes('type="static"') || /<!DOCTYPE|<!ENTITY|<BaseURL|<Location|xlink:href/i.test(manifest)) throw new IngestionError("OUTPUT_INVALID");
  const adaptations = [...manifest.matchAll(/<AdaptationSet\b[^>]*>([\s\S]*?)<\/AdaptationSet>/g)];
  if (adaptations.length !== (source.audio ? 2 : 1)) throw new IngestionError("OUTPUT_INVALID");
  const tracks: { id: string; video: boolean; names: string[] }[] = [];
  for (const adaptation of adaptations) {
    const ids = [...adaptation[1].matchAll(/<Representation\b[^>]*\bid="(\d{1,3})"/g)];
    const template = /<SegmentTemplate\b([^>]*)>/.exec(adaptation[1]);
    if (ids.length !== 1 || !template || !template[1].includes('initialization="init-$RepresentationID$.mp4"') || !template[1].includes('media="segment-$RepresentationID$-$Number%05d$.m4s"')) throw new IngestionError("OUTPUT_INVALID");
    const id = ids[0][1], video = /mimeType="video\/mp4"/.test(adaptation[0]);
    const timescale = Number(/timescale="(\d+)"/.exec(template[1])?.[1]);
    if (!timescale || !template[1].includes('startNumber="1"')) throw new IngestionError("OUTPUT_INVALID");
    let count = 0, end = 0;
    for (const match of adaptation[1].matchAll(/<S\b([^>]*)\/>/g)) {
      const d = Number(/\bd="(\d+)"/.exec(match[1])?.[1]);
      const r = Number(/\br="(\d+)"/.exec(match[1])?.[1] || 0);
      const t = Number(/\bt="(\d+)"/.exec(match[1])?.[1] || end);
      if (!Number.isSafeInteger(d) || d <= 0 || !Number.isSafeInteger(r) || r > 10000 || Math.abs(t - end) > timescale / 10) throw new IngestionError("OUTPUT_INVALID");
      count += r + 1; end = t + d * (r + 1);
    }
    if (!count || count > 5000 || Math.abs(end / timescale - source.duration) > 0.15) throw new IngestionError("OUTPUT_INVALID");
    const names = [`init-${id}.mp4`, ...Array.from({ length: count }, (_, i) => `segment-${id}-${String(i + 1).padStart(5, "0")}.m4s`)];
    if (names.some(n => !bridge.objects.has(n))) throw new IngestionError("OUTPUT_INVALID");
    tracks.push({ id, video, names });
  }
  if (tracks.filter(t => t.video).length !== 1 || new Set(tracks.flatMap(t => t.names)).size !== bridge.objects.size) throw new IngestionError("OUTPUT_INVALID");
  return tracks;
}
export async function validateTimelines(bridge: MediaBridge, manifest: string, source: SourceInfo, segmentSeconds: number, config: IngestionConfig, signal: AbortSignal) {
  const tracks = validateManifest(manifest, bridge, source);
  for (const track of tracks) {
    let first: number | undefined, end: number | undefined, packets = 0, keyframes = 0;
    const keys: number[] = [];
    async function* input() { for (const name of track.names) yield await bridge.read(bridge.objects.get(name)!); }
    await mediaProcess(config.ffprobe, ["-v", "error", "-max_alloc", "134217728", "-protocol_whitelist", "pipe", "-f", "mov", "-show_packets", "-show_entries", "packet=pts_time,duration_time,flags", "-of", "compact=p=0", "pipe:0"], { signal, input: input(), line(line) {
      if (!line.trim()) return;
      const values = Object.fromEntries(line.split("|").map(pair => pair.split("=")));
      const pts = Number(values.pts_time), duration = Number(values.duration_time);
      if (!Number.isFinite(pts) || !Number.isFinite(duration) || duration <= 0 || (end !== undefined && Math.abs(pts - end) > 0.002) || ++packets > config.maxDurationSeconds * 65 + 100) throw new IngestionError("OUTPUT_INVALID");
      first ??= pts; end = pts + duration;
      if (track.video && values.flags?.includes("K")) { keyframes++; keys.push(pts); }
    } });
    if (!packets || first === undefined || end === undefined || Math.abs(first) > 0.03 || Math.abs(end - source.duration) > 0.15) throw new IngestionError("OUTPUT_INVALID");
    if (track.video && (keyframes !== track.names.length - 1 || keys.some((t, i) => Math.abs(t - i * segmentSeconds) > 0.035))) throw new IngestionError("OUTPUT_INVALID");
  }
}
