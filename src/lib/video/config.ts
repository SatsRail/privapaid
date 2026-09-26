import { createHash } from "node:crypto";
import path from "node:path";

export class VideoSetupError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export type VideoConfig = {
  provider: "local" | "s3";
  localRoot: string;
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string;
  forcePathStyle: boolean;
  leaseSeconds: number;
  keyFingerprint: string;
};
export function videoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VIDEO_PIPELINE_ENABLED === "true";
}
export function videoConfig(env: Record<string, string | undefined> = process.env): VideoConfig {
  if (!videoEnabled(env)) throw new VideoSetupError("VIDEO_DISABLED");
  if (!env.CONTENT_KEK || !/^[A-Za-z0-9+/_-]{43}=?$/.test(env.CONTENT_KEK) ||
      Buffer.from(env.CONTENT_KEK, "base64").length !== 32) {
    throw new VideoSetupError("VIDEO_CONTENT_KEK_REQUIRED");
  }
  const provider = env.VIDEO_STORAGE_PROVIDER || "local";
  if (provider !== "local" && provider !== "s3") throw new VideoSetupError("VIDEO_PROVIDER_INVALID");
  const localRoot = env.VIDEO_LOCAL_ROOT || path.resolve("data/video-pipeline");
  const publicRoot = path.resolve("public");
  if (provider === "local" && (!path.isAbsolute(localRoot) || localRoot === publicRoot || localRoot.startsWith(publicRoot + path.sep))) {
    throw new VideoSetupError("VIDEO_LOCAL_ROOT_MUST_BE_PRIVATE_ABSOLUTE_PATH");
  }
  const bucket = env.VIDEO_S3_BUCKET || "";
  const region = env.VIDEO_S3_REGION || "";
  const prefix = env.VIDEO_S3_PREFIX || "privapaid-video/";
  if (provider === "s3" && (!bucket || !region)) throw new VideoSetupError("VIDEO_S3_BUCKET_AND_REGION_REQUIRED");
  if (!/^[a-zA-Z0-9_/-]{1,128}\/$/.test(prefix) || prefix.includes("//")) throw new VideoSetupError("VIDEO_S3_PREFIX_INVALID");
  const endpoint = env.VIDEO_S3_ENDPOINT || undefined;
  if (endpoint) {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new VideoSetupError("VIDEO_S3_ENDPOINT_INVALID"); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && local && env.NODE_ENV !== "production"))) {
      throw new VideoSetupError("VIDEO_S3_ENDPOINT_INVALID");
    }
  }
  const leaseSeconds = Number(env.VIDEO_JOB_LEASE_SECONDS || 60);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 300) throw new VideoSetupError("VIDEO_LEASE_INVALID");
  const keyFingerprint = createHash("sha256").update("privapaid/video-worker-kek/v1").update(Buffer.from(env.CONTENT_KEK, "base64")).digest("hex");
  return { provider, localRoot, bucket, region, prefix, endpoint, forcePathStyle: env.VIDEO_S3_PATH_STYLE === "true", leaseSeconds, keyFingerprint };
}

export function storageIdentity(config: VideoConfig): string {
  const locator = config.provider === "local" ? [config.localRoot] : [config.bucket, config.region, config.prefix, config.endpoint || "aws", config.forcePathStyle];
  return createHash("sha256").update(JSON.stringify([config.provider, config.keyFingerprint, ...locator])).digest("hex");
}
