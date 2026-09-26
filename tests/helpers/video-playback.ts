import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { encryptDescriptor, sealObject, sha256 } from "@/lib/video/format";
import { attemptPrefix, issueGrant } from "@/lib/video/delivery-grant";
import { deliveryConfig } from "@/lib/video/delivery-config";
import type { PlaybackSession } from "@/lib/video/playback-contract";
import type { VideoStorage } from "@/lib/video/storage/types";
export const testPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
export function playbackEnv(root: string) {
  return { VIDEO_PIPELINE_ENABLED: "true", VIDEO_PLAYBACK_ENABLED: "true", VIDEO_STORAGE_PROVIDER: "local", VIDEO_LOCAL_ROOT: root,
    VIDEO_DELIVERY_PROVIDER: "local", VIDEO_DELIVERY_TTL_SECONDS: "15", VIDEO_DELIVERY_PRIVATE_KEY: testPrivateKey,
    VIDEO_CLOUDFRONT_KEY_PAIR_ID: "TESTKEY", AUTH_URL: "https://app.video.test", VIDEO_MEDIA_ORIGIN: "https://media.video.test" };
}
export async function encryptedMovie(storage: VideoStorage, objects: Record<string, Buffer>) {
  const root = randomBytes(32), dek = randomBytes(32), productKey = randomBytes(32).toString("base64url");
  const asset = randomUUID(), version = randomUUID(), attempt = randomUUID(), productId = randomUUID();
  const prefix = attemptPrefix(asset, version, attempt), encrypted: Record<string, Buffer> = {};
  const entries = [];
  for (const [name, plain] of Object.entries(objects)) {
    const wire = sealObject(root, { asset, version, attempt, name }, plain); encrypted[name] = wire;
    entries.push({ name, bytes: plain.length, encryptedBytes: wire.length, sha256: sha256(plain), encryptedSha256: sha256(wire) });
  }
  encrypted["catalog.json"] = sealObject(root, { asset, version, attempt, name: "catalog.json" },
    Buffer.from(JSON.stringify({ format: 1, asset, version, attempt, objects: entries })));
  const descriptor = { format: 1 as const, asset, version, attempt, prefix, rootKey: root.toString("base64url"),
    manifest: { name: "play.mpd" as const, sha256: sha256(encrypted["play.mpd"]) }, catalog: { name: "catalog.json" as const, sha256: sha256(encrypted["catalog.json"]) } };
  const encryptedDescriptor = encryptDescriptor(dek, asset, version, descriptor);
  for (const [name, wire] of Object.entries(encrypted)) await storage.put(`${prefix}/${name}`, Readable.from([wire]), wire.length);
  const config = deliveryConfig(), now = Date.now(), expiresAt = Math.floor((now + config.ttlSeconds * 1000) / 1000) * 1000;
  const session: PlaybackSession = { format: 1, asset, version, attempt, prefix, objectBase: `${config.objectBase}${prefix}/`, grantUrl: config.grantUrl,
    serverTime: now, expiresAt, grant: issueGrant(config, prefix, expiresAt), encryptedDescriptor: encryptedDescriptor.toString("base64"),
    key: productKey, key_fingerprint: sha256(productKey), product_id: productId,
    encrypted_blob: encryptSourceUrl(dek.toString("base64url"), productKey, productId), remaining_seconds: 3600 };
  return { session, encrypted, descriptor, encryptedDescriptor, root, dek };
}
