// Shared, deterministic profile/estimate data. No server secrets or dependencies.
export const ADAPTIVE_PROFILE = "h264-aac-abr720p30-v1-experimental";
export const LEGACY_PROFILE = "h264-aac-720p30-v1-experimental";
export const SEGMENT_PRESETS = [4, 10] as const;
export type Rendition = { width: number; height: number; bitrate: number; maxrate: number };
const tiers = [
  { width: 640, height: 360, bitrate: 500000, maxrate: 750000 },
  { width: 854, height: 480, bitrate: 900000, maxrate: 1250000 },
  { width: 1280, height: 720, bitrate: 1800000, maxrate: 2300000 },
];
export function qualityLadder(width: number, height: number): Rendition[] {
  if (![width, height].every(n => Number.isInteger(n) && n >= 16 && n <= 4096)) throw new Error("INVALID_DIMENSIONS");
  const result: Rendition[] = [];
  for (const tier of tiers) {
    const scale = Math.min(1, tier.width / width, tier.height / height);
    const size = { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2) };
    if (!result.some(r => r.width === size.width && r.height === size.height)) result.push({ ...tier, ...size });
  }
  return result;
}
export function videoEstimate(duration: number, width: number, height: number, segmentSeconds: number) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 14400 || !SEGMENT_PRESETS.some(n => n === segmentSeconds)) return null;
  const qualities = qualityLadder(width, height), segments = Math.ceil(duration / segmentSeconds);
  // Assume audio for a conservative estimate. Actual audio packet boundaries,
  // variable bitrate, codec overhead and quality switches change these counts.
  return { qualities, segmentsPerTrack: segments, viewerRequests: segments * 2 + 4,
    storedObjects: (segments + 1) * (qualities.length + 1) + 2,
    outputBytes: Math.ceil(duration * (qualities.reduce((sum, r) => sum + r.bitrate, 0) + 128000) / 8 * 1.05),
    pixelWork: qualities.reduce((sum, r) => sum + r.width * r.height, 0) / (qualities.at(-1)!.width * qualities.at(-1)!.height) };
}
