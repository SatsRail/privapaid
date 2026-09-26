import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { getDomain } from "tldts";
import { videoConfig, videoEnabled, VideoSetupError, type VideoConfig } from "./config";

export type DeliveryConfig = {
  storage: VideoConfig;
  provider: "local" | "cloudfront";
  appOrigin: string;
  mediaOrigin: string;
  objectBase: string;
  grantUrl: string;
  ttlSeconds: number;
  keyPairId: string;
  privateKey: string;
  publicKey: KeyObject;
  secure: boolean;
};
export function playbackEnabled(env = process.env) {
  return videoEnabled(env) && env.VIDEO_PLAYBACK_ENABLED === "true";
}
function origin(value: string | undefined): URL {
  try {
    const url = new URL(value || "");
    if (url.origin === "null" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url;
  } catch { throw new VideoSetupError("VIDEO_DELIVERY_ORIGIN_INVALID"); }
}
let cache: { pem: string; publicKey: KeyObject } | undefined;
export function deliveryConfig(env = process.env): DeliveryConfig {
  if (!playbackEnabled(env)) throw new VideoSetupError("VIDEO_PLAYBACK_DISABLED");
  const storage = videoConfig(env);
  const provider = env.VIDEO_DELIVERY_PROVIDER || "cloudfront";
  if (provider !== "cloudfront" && provider !== "local") throw new VideoSetupError("VIDEO_DELIVERY_PROVIDER_INVALID");
  if (provider === "local" && (env.NODE_ENV === "production" || storage.provider !== "local")) throw new VideoSetupError("VIDEO_LOCAL_DELIVERY_DEVELOPMENT_ONLY");
  if (provider === "cloudfront" && (storage.provider !== "s3" || storage.endpoint || storage.forcePathStyle)) throw new VideoSetupError("VIDEO_CLOUDFRONT_REQUIRES_AWS_S3");
  const app = origin(env.AUTH_URL || env.NEXTAUTH_URL), media = origin(env.VIDEO_MEDIA_ORIGIN);
  // Different ports don't isolate cookies. Use a dedicated sibling hostname
  // in the SAME schemeful site; no third-party cookie dependency.
  const site = getDomain(app.hostname, { allowPrivateDomains: true });
  if (app.hostname === media.hostname || app.protocol !== media.protocol || !site ||
      site !== getDomain(media.hostname, { allowPrivateDomains: true }) ||
      (provider === "cloudfront" && (app.protocol !== "https:" || app.port || media.port)) ||
      !["http:", "https:"].includes(app.protocol)) throw new VideoSetupError("VIDEO_FIRST_PARTY_MEDIA_HOST_REQUIRED");
  const ttlSeconds = Number(env.VIDEO_DELIVERY_TTL_SECONDS || 300);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 15 || ttlSeconds > 300) throw new VideoSetupError("VIDEO_DELIVERY_TTL_INVALID");
  const keyPairId = env.VIDEO_CLOUDFRONT_KEY_PAIR_ID || "";
  const privateKey = env.VIDEO_DELIVERY_PRIVATE_KEY || "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(keyPairId)) throw new VideoSetupError("VIDEO_DELIVERY_SIGNING_KEY_REQUIRED");
  try {
    if (cache?.pem !== privateKey) {
      const key = createPrivateKey(privateKey);
      if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error();
      cache = { pem: privateKey, publicKey: createPublicKey(key) };
    }
  } catch { throw new VideoSetupError("VIDEO_DELIVERY_RSA_2048_KEY_REQUIRED"); }
  return { storage, provider, appOrigin: app.origin, mediaOrigin: media.origin,
    objectBase: `${media.origin}/${provider === "local" ? "api/video-delivery/objects/" : storage.prefix}`,
    grantUrl: `${media.origin}/api/video-delivery/grant`, ttlSeconds, keyPairId, privateKey,
    publicKey: cache!.publicKey, secure: media.protocol === "https:" };
}
