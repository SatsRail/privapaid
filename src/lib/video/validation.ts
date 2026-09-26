import { IngestionError } from "./ingestion-errors";
import { mediaProcess, safeInputArgs } from "./process";
import type { IngestionConfig } from "./ingestion-config";
import { ADAPTIVE_PROFILE, LEGACY_PROFILE, qualityLadder } from "./quality";
import type { MediaBridge } from "./bridge";
export type SourceInfo = { duration: number; audio: boolean; width: number; height: number };
export async function probeSource(url: string, config: IngestionConfig, signal: AbortSignal): Promise<SourceInfo> {
  const raw = await mediaProcess(config.ffprobe, ["-v", "error", "-max_alloc", "134217728", ...safeInputArgs,
    "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,sample_aspect_ratio:stream_side_data=rotation:stream_disposition=attached_pic:format=duration,format_name", "-of", "json", url], { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  try {
    const info = JSON.parse(raw), streams = info.streams as { codec_type: string; codec_name: string; width: number; height: number; pix_fmt: string; avg_frame_rate: string; sample_aspect_ratio?: string; side_data_list?: { rotation?: number }[]; disposition?: { attached_pic?: number } }[];
    const video = streams.filter(s => s.codec_type === "video"), audio = streams.filter(s => s.codec_type === "audio");
    const duration = Number(info.format?.duration), [numerator, denominator] = (video[0]?.avg_frame_rate || "0/0").split("/").map(Number);
    const fps = numerator / denominator;
    if (video.length !== 1 || audio.length > 1 || streams.length !== video.length + audio.length ||
        video[0].codec_name !== "h264" || video[0].pix_fmt !== "yuv420p" || video[0].disposition?.attached_pic || audio.some(s => s.codec_name !== "aac") ||
        !Number.isFinite(fps) || fps <= 0 || fps > 60 || video[0].width < 16 || video[0].height < 16 || video[0].width > 3840 || video[0].height > 2160 ||
        !Number.isFinite(duration) || duration <= 0 || duration > config.maxDurationSeconds || !String(info.format.format_name).split(",").includes("mp4")) throw new Error();
    const rotation = video[0].side_data_list?.find(d => d.rotation !== undefined)?.rotation || 0;
    if (![0, 90, -90, 180, -180, 270, -270].includes(rotation) ||
        (video[0].sample_aspect_ratio && !["1:1", "N/A"].includes(video[0].sample_aspect_ratio))) throw new Error();
    const swapped = Math.abs(rotation) % 180 === 90;
    return { duration, audio: audio.length === 1, width: swapped ? video[0].height : video[0].width, height: swapped ? video[0].width : video[0].height };
  } catch { throw new IngestionError("INVALID_VIDEO", 422); }
}
export function validateManifest(manifest: string, bridge: Pick<MediaBridge, "objects">, source: SourceInfo, profile = ADAPTIVE_PROFILE) {
  const fail = () => { throw new IngestionError("OUTPUT_INVALID"); };
  if (!manifest.includes('type="static"') || /<!DOCTYPE|<!ENTITY|<BaseURL|<Location|xlink:href/i.test(manifest)) fail();
  const adaptations = [...manifest.matchAll(/<AdaptationSet\b[^>]*>([\s\S]*?)<\/AdaptationSet>/g)];
  if (adaptations.length !== (source.audio ? 2 : 1)) fail();
  const expected = qualityLadder(source.width, source.height);
  const qualities = profile === LEGACY_PROFILE ? [expected.at(-1)!] : profile === ADAPTIVE_PROFILE ? expected : [];
  if (!qualities.length) fail();
  const tracks: { id: string; video: boolean; names: string[]; starts: number[] }[] = [];
  for (const adaptation of adaptations) {
    const representations = [...adaptation[1].matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g)];
    const video = /mimeType="video\/mp4"/.test(adaptation[0]);
    if (representations.length !== (video ? qualities.length : 1)) fail();
    for (const [index, representation] of representations.entries()) {
      const id = /\bid="(\d{1,3})"/.exec(representation[1])?.[1];
      const template = /<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/.exec(representation[2]);
      if (!id || !template || !template[1].includes('initialization="init-$RepresentationID$.mp4"') || !template[1].includes('media="segment-$RepresentationID$-$Number%05d$.m4s"')) fail();
      if (video && (Number(/\bwidth="(\d+)"/.exec(representation[1])?.[1]) !== qualities[index].width ||
          Number(/\bheight="(\d+)"/.exec(representation[1])?.[1]) !== qualities[index].height)) fail();
      const timescale = Number(/timescale="(\d+)"/.exec(template![1])?.[1]);
      if (!timescale || !template![1].includes('startNumber="1"')) fail();
      let count = 0, end = 0; const starts: number[] = [];
      for (const match of template![2].matchAll(/<S\b([^>]*)\/>/g)) {
        const d = Number(/\bd="(\d+)"/.exec(match[1])?.[1]);
        const r = Number(/\br="(\d+)"/.exec(match[1])?.[1] || 0);
        const t = Number(/\bt="(\d+)"/.exec(match[1])?.[1] || end);
        if (!Number.isSafeInteger(d) || d <= 0 || !Number.isSafeInteger(r) || r > 5000 || Math.abs(t - end) > timescale / 10 || count + r + 1 > 5000) fail();
        for (let n = 0; n <= r; n++) starts.push((t + n * d) / timescale);
        count += r + 1; end = t + d * (r + 1);
      }
      if (!count || Math.abs(end / timescale - source.duration) > 0.15) fail();
      const names = [`init-${id}.mp4`, ...Array.from({ length: count }, (_, i) => `segment-${id}-${String(i + 1).padStart(5, "0")}.m4s`)];
      if (names.some(n => !bridge.objects.has(n))) fail();
      tracks.push({ id: id!, video, names, starts });
    }
  }
  const video = tracks.filter(t => t.video);
  if (video.length !== qualities.length || new Set(tracks.map(t => t.id)).size !== tracks.length ||
      new Set(tracks.flatMap(t => t.names)).size !== bridge.objects.size) fail();
  for (const track of video) if (track.starts.length !== video[0].starts.length || track.starts.some((t, i) => Math.abs(t - video[0].starts[i]) > 0.001)) fail();
  return tracks;
}
export async function validateTimelines(bridge: Pick<MediaBridge, "objects" | "read">, manifest: string, source: SourceInfo, segmentSeconds: number, config: IngestionConfig, signal: AbortSignal, profile = ADAPTIVE_PROFILE) {
  const tracks = validateManifest(manifest, bridge, source, profile);
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
    if (track.video && (keyframes !== track.names.length - 1 || keys.some((t, i) => Math.abs(t - i * segmentSeconds) > 0.035 || Math.abs(t - track.starts[i]) > 0.002))) throw new IngestionError("OUTPUT_INVALID");
  }
}
