import { VideoSetupError } from "./config";
export const PART_BYTES = 8 * 1024 ** 2;
export const MAX_SOURCE_BYTES = 10 * 1024 ** 3;
export const MAX_OBJECT_BYTES = 32 * 1024 ** 2;
export const MAX_OBJECTS = 10000;
export const OUTPUT_BUDGET = 8 * 1024 ** 3;
export const MAX_ATTEMPTS = 3;
export function ingestionConfig(env: Record<string, string | undefined> = process.env) {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new VideoSetupError(`${name}_INVALID`);
    return value;
  };
  return {
    maxStorageBytes: integer("VIDEO_MAX_STORAGE_BYTES", 100 * 1024 ** 3, MAX_SOURCE_BYTES, 1024 ** 5),
    maxPending: integer("VIDEO_MAX_PENDING_JOBS", 4, 1, 100),
    maxTransfers: integer("VIDEO_MAX_ACTIVE_TRANSFERS", 2, 1, 8),
    maxDurationSeconds: integer("VIDEO_MAX_DURATION_SECONDS", 4 * 3600, 1, 4 * 3600),
    threads: integer("VIDEO_ENCODING_THREADS", 2, 1, 8),
    jobTimeoutSeconds: integer("VIDEO_ENCODING_TIMEOUT_SECONDS", 8 * 3600, 60, 12 * 3600),
    retentionSeconds: integer("VIDEO_STAGING_RETENTION_SECONDS", 24 * 3600, 3600, 7 * 86400),
    minFreeBytes: integer("VIDEO_MIN_FREE_BYTES", 1024 ** 3, 128 * 1024 ** 2, 100 * 1024 ** 3),
    ffmpeg: env.FFMPEG_PATH || "ffmpeg", ffprobe: env.FFPROBE_PATH || "ffprobe",
  };
}
export type IngestionConfig = ReturnType<typeof ingestionConfig>;
