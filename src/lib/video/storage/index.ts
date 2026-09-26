import { S3Client } from "@aws-sdk/client-s3";
import { storageIdentity, type VideoConfig } from "../config";
import { LocalVideoStorage } from "./local";
import { S3VideoStorage } from "./s3";
import type { VideoStorage } from "./types";
let cached: { id: string; storage: VideoStorage; client: S3Client } | undefined;
export function videoStorage(config: VideoConfig): VideoStorage {
  if (config.provider === "local") return new LocalVideoStorage(config.localRoot);
  // Standard AWS credential chain: workload IAM role preferred. Never accept
  // browser credentials or persist credentials in queue payloads.
  const id = storageIdentity(config);
  if (cached?.id === id) return cached.storage;
  cached?.client.destroy();
  const client = new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: config.forcePathStyle, maxAttempts: 3, requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 } });
  cached = { id, client, storage: new S3VideoStorage(client, config.bucket, config.prefix) };
  return cached.storage;
}
