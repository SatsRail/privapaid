import { prisma } from "@/lib/prisma";
import { getProductsForMedia, verifyMacaroonAccess } from "@/lib/access-gate";
import { storageIdentity } from "./config";
import { deliveryConfig } from "./delivery-config";
import { attemptPrefix, issueGrant, PlaybackError } from "./delivery-grant";
import { HASH, UUID, type PlaybackSession } from "./playback-contract";
import { sha256 } from "./format";

async function snapshot(mediaId: string, version?: string) {
  const media = await prisma.media.findFirst({ where: { id: mediaId, deletedAt: null, status: "ok", mediaType: "video",
    channel: { active: true, deletedAt: null } }, include: { videoAsset: true } });
  if (!media?.videoAsset?.publishedVersionId) throw new PlaybackError("VIDEO_NOT_READY", 404);
  const row = await prisma.videoAssetVersion.findFirst({ where: { id: version || media.videoAsset.publishedVersionId,
    assetId: media.videoAsset.id, status: "ready", formatVersion: 1, deletedAt: null } });
  if (!row?.encryptedDescriptor || !row.manifestKey || !row.readyAt) throw new PlaybackError("VIDEO_NOT_READY", 404);
  return { media, row };
}
export async function startPlaybackSession(mediaId: string, pinnedVersion?: string): Promise<PlaybackSession> {
  const config = deliveryConfig();
  if (!mediaId || mediaId.length > 128 || (pinnedVersion && !UUID.test(pinnedVersion))) throw new PlaybackError("INVALID_SESSION", 400);
  const before = await snapshot(mediaId, pinnedVersion);
  const products = await getProductsForMedia(mediaId, before.media.channelId, { includeArchived: true });
  const access = await verifyMacaroonAccess(products.map(p => p.productId));
  if (!access.granted) throw new PlaybackError(access.reason === "unavailable" ? "ACCESS_UNAVAILABLE" : "ACCESS_DENIED",
    access.reason === "unavailable" ? 503 : 401, access.retryAfterSeconds || 5);
  // Old API deployments remain compatible with legacy content, but cannot
  // mint video delivery grants using an unbounded token-only lifetime.
  if (!access.verifiedUntil) throw new PlaybackError("ACCESS_BOUNDS_REQUIRED");
  const after = await snapshot(mediaId, before.row.id);
  const { row } = after;
  const freshProducts = await getProductsForMedia(mediaId, after.media.channelId, { includeArchived: true });
  const product = freshProducts.find(p => p.productId === access.productId);
  if (!product?.encryptedBlob || !access.key || !access.keyFingerprint || !HASH.test(access.keyFingerprint) ||
      product.keyFingerprint !== access.keyFingerprint || sha256(access.key) !== access.keyFingerprint ||
      !Buffer.from(row.encryptedDescriptor!).equals(Buffer.from(before.row.encryptedDescriptor!))) throw new PlaybackError("KEY_STATE_CHANGED");
  if (row.storageIdentity !== storageIdentity(config.storage) || row.provider !== config.storage.provider) throw new PlaybackError("VIDEO_STORAGE_CHANGED");
  const attempt = row.manifestKey!.split("/").at(-2)!;
  const prefix = attemptPrefix(row.assetId, row.id, attempt);
  if (row.manifestKey !== `${prefix}/play.mpd`) throw new PlaybackError("VIDEO_NOT_READY", 404);
  const now = Date.now();
  // Two seconds of clock/round-trip safety plus whole-second downward rounding.
  const expiresAt = Math.floor(Math.min(access.verifiedUntil - 2000, now + config.ttlSeconds * 1000) / 1000) * 1000;
  if (expiresAt <= now + 1000) throw new PlaybackError("ACCESS_DENIED", 401);
  return { format: 1, asset: row.assetId, version: row.id, attempt, prefix,
    objectBase: `${config.objectBase}${prefix}/`, grantUrl: config.grantUrl,
    grant: issueGrant(config, prefix, expiresAt), expiresAt, serverTime: now,
    encryptedDescriptor: Buffer.from(row.encryptedDescriptor!).toString("base64"),
    key: access.key, key_fingerprint: access.keyFingerprint, product_id: access.productId!,
    encrypted_blob: product.encryptedBlob, remaining_seconds: Math.max(0, Math.floor((access.verifiedUntil - now) / 1000)) };
}
