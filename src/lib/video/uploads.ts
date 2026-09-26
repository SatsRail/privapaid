import { randomBytes, randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { Readable } from "node:stream";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { wrapDek, unwrapDek } from "@/lib/content-dek";
import { videoConfig, storageIdentity, type VideoConfig } from "./config";
import { ingestionConfig, PART_BYTES, MAX_SOURCE_BYTES, MAX_ATTEMPTS, OUTPUT_BUDGET } from "./ingestion-config";
import { IngestionError } from "./ingestion-errors";
import { verifyProductBinding, assertLocalBinding, bindingFrom } from "./product-gate";
import { sha256, uuidPattern, sealObject, openObject, sourceName } from "./format";
import { boundedBytes, objectBytes } from "./streams";
import { StorageError, type VideoStorage } from "./storage/types";
import { cancelVersion } from "./assets";

import { ADAPTIVE_PROFILE } from "./quality";

const include = { version: { include: { asset: true, job: true } } } as const;
export type Upload = Prisma.VideoUploadSessionGetPayload<{ include: typeof include }>;
const reservation = (size: number) => BigInt(size + Math.ceil(size / PART_BYTES) * 32 + MAX_ATTEMPTS * OUTPUT_BUDGET);
// Transaction-level instance lock serializes quota reservations across replicas.
export async function lockQuota(tx: Prisma.TransactionClient) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(1886418481)`; }
export async function ownedUpload(id: string, ownerId: string): Promise<Upload> {
  if (!uuidPattern.test(id)) throw new IngestionError("UPLOAD_NOT_FOUND", 404);
  const upload = await prisma.videoUploadSession.findFirst({ where: { id, ownerId }, include });
  if (!upload || upload.version.formatVersion !== 1) throw new IngestionError("UPLOAD_NOT_FOUND", 404);
  return upload;
}
export function uploadView(upload: Upload) {
  return { id: upload.id, versionId: upload.versionId, mediaId: upload.version.asset.mediaId,
    status: upload.version.status, uploadStatus: upload.status, bytes: Number(upload.expectedBytes),
    receivedBytes: Number(upload.receivedBytes), partBytes: upload.partBytes, clientFingerprint: upload.clientFingerprint,
    segmentSeconds: upload.version.segmentSeconds, encodingProfile: upload.version.encodingProfile,
    durationSeconds: upload.version.durationMs ? Number(upload.version.durationMs) / 1000 : null,
    encryptedBytes: upload.version.encryptedBytes.toString(), objectCount: upload.version.objectCount, progress: upload.version.progress,
    error: upload.version.job?.lastErrorCode || null, expiresAt: upload.expiresAt.toISOString(),
    canRetry: upload.version.status === "failed" && !upload.version.sourceCleanedAt && upload.status === "completed",
    published: upload.version.asset.publishedVersionId === upload.versionId };
}
export async function startUpload(ownerId: string, input: { mediaId: string; productId: string; bytes: number; segmentSeconds: 4 | 10; clientFingerprint: string; idempotencyKey: string }, config = videoConfig()) {
  if (!input || typeof input.mediaId !== "string" || !input.mediaId || typeof input.productId !== "string" || !input.productId || !Number.isSafeInteger(input.bytes) || input.bytes < 12 || input.bytes > MAX_SOURCE_BYTES ||
      ![4, 10].includes(input.segmentSeconds) || typeof input.clientFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.clientFingerprint) || typeof input.idempotencyKey !== "string" || !uuidPattern.test(input.idempotencyKey)) throw new IngestionError("INVALID_UPLOAD", 422);
  const existing = await prisma.videoUploadSession.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include });
  const match = (value: Upload) => {
    if (value.ownerId !== ownerId || value.version.asset.mediaId !== input.mediaId || value.expectedBytes !== BigInt(input.bytes) ||
        value.clientFingerprint !== input.clientFingerprint || value.productId !== input.productId || value.version.segmentSeconds !== input.segmentSeconds) throw new IngestionError("UPLOAD_CONFLICT");
    return value;
  };
  if (existing) return match(existing);
  const binding = await verifyProductBinding(input.mediaId, input.productId);
  const limits = ingestionConfig();
  const root = randomBytes(32); let wrapped: string;
  try { wrapped = wrapDek(root); } finally { root.fill(0); }
  return prisma.$transaction(async tx => {
    await lockQuota(tx);
    const retry = await tx.videoUploadSession.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include });
    if (retry) return match(retry);
    await assertLocalBinding(tx, input.mediaId, binding);
    const used = await tx.videoAssetVersion.aggregate({ _sum: { reservedBytes: true } });
    if ((used._sum.reservedBytes || BigInt(0)) + reservation(input.bytes) > BigInt(limits.maxStorageBytes)) throw new IngestionError("STORAGE_QUOTA", 507);
    if (await tx.videoAssetVersion.count({ where: { status: { in: ["uploading", "queued", "processing"] }, formatVersion: 1 } }) >= limits.maxPending) throw new IngestionError("JOB_QUOTA", 429);
    const asset = await tx.videoAsset.upsert({ where: { mediaId: input.mediaId }, create: { mediaId: input.mediaId }, update: { generation: { increment: 0 } } });
    const next = await tx.videoAsset.update({ where: { id: asset.id }, data: { generation: { increment: 1 } } });
    const id = randomUUID();
    await tx.videoAssetVersion.create({ data: { id, assetId: asset.id, generation: next.generation, provider: config.provider,
      storageIdentity: storageIdentity(config), storagePrefix: `assets/${asset.id}/versions/${id}`, wrappedRootKey: wrapped,
      formatVersion: 1, encodingProfile: ADAPTIVE_PROFILE, segmentSeconds: input.segmentSeconds,
      reservedBytes: reservation(input.bytes), upload: { create: { ownerId, expectedBytes: BigInt(input.bytes),
        idempotencyKey: input.idempotencyKey, clientFingerprint: input.clientFingerprint, ...binding,
        expiresAt: new Date(Date.now() + 24 * 3600_000) } } } });
    return tx.videoUploadSession.findUniqueOrThrow({ where: { versionId: id }, include });
  });
}
export function assertStore(upload: Upload, config: VideoConfig) {
  if (upload.version.storageIdentity !== storageIdentity(config)) throw new IngestionError("STORAGE_UNAVAILABLE", 503, true);
}
export async function readSourcePart(storage: VideoStorage, upload: Upload, index: number, root: Buffer, signal?: AbortSignal) {
  const expected = Math.min(upload.partBytes, Number(upload.expectedBytes) - index * upload.partBytes);
  if (!Number.isInteger(index) || index < 0 || expected <= 0) throw new IngestionError("INVALID_UPLOAD");
  const name = sourceName(index);
  const encrypted = await objectBytes(await storage.read(`${upload.version.storagePrefix}/source/${name}`), expected + 32, signal);
  const plain = openObject(root, { asset: upload.version.assetId, version: upload.versionId, attempt: upload.id, name }, encrypted);
  if (plain.length !== expected) { plain.fill(0); throw new IngestionError("OUTPUT_INVALID"); }
  return plain;
}
export async function receivePart(id: string, ownerId: string, offset: number, checksum: string, body: AsyncIterable<Uint8Array>, storage: VideoStorage, config = videoConfig(), signal?: AbortSignal) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % PART_BYTES !== 0 || !/^[a-f0-9]{64}$/.test(checksum)) throw new IngestionError("INVALID_UPLOAD", 422);
  const upload = await ownedUpload(id, ownerId); assertStore(upload, config);
  const wanted = Math.min(upload.partBytes, Number(upload.expectedBytes) - offset);
  if (wanted <= 0 || offset > Number(upload.receivedBytes)) throw new IngestionError("UPLOAD_CONFLICT");
  const token = randomUUID(), limits = ingestionConfig();
  await prisma.$transaction(async tx => {
    await lockQuota(tx);
    await assertLocalBinding(tx, upload.version.asset.mediaId, bindingFrom(upload));
    const active = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM "VideoUploadSession" WHERE "requestExpiresAt" > clock_timestamp()`;
    if (Number(active[0].count) >= limits.maxTransfers) throw new IngestionError("UPLOAD_BUSY", 429, true);
    const n = await tx.$executeRaw`UPDATE "VideoUploadSession" SET "requestToken" = ${token}::uuid,
      "requestExpiresAt" = clock_timestamp() + interval '120 seconds', "updatedAt" = clock_timestamp()
      WHERE id = ${id}::uuid AND status = 'open' AND "expiresAt" > clock_timestamp()
        AND ("requestExpiresAt" IS NULL OR "requestExpiresAt" <= clock_timestamp())
        AND "receivedBytes" >= ${BigInt(offset)} AND EXISTS (
          SELECT 1 FROM "VideoAssetVersion" WHERE id = "VideoUploadSession"."versionId" AND status = 'uploading')`;
    if (!n) {
      const busy = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "VideoUploadSession" WHERE id = ${id}::uuid AND status = 'open' AND "expiresAt" > clock_timestamp() AND "requestExpiresAt" > clock_timestamp()`;
      if (busy.length) throw new IngestionError("UPLOAD_BUSY", 429, true);
      throw new IngestionError("UPLOAD_CLOSED");
    }
  });
  let plain: Buffer | undefined, root: Buffer | undefined;
  try {
    await storage.check();
    if (config.provider === "local") {
      const disk = await statfs(config.localRoot);
      if (disk.bavail * disk.bsize < limits.minFreeBytes + wanted + 32) throw new IngestionError("STORAGE_FULL", 507);
    }
    plain = await boundedBytes(body, wanted, signal);
    if (plain.length !== wanted || sha256(plain) !== checksum) throw new IngestionError("CHECKSUM_MISMATCH", 422);
    if (offset === 0) {
      const size = plain.readUInt32BE(0);
      if (plain.toString("ascii", 4, 8) !== "ftyp" || size < 16 || size > 4096 || size > plain.length ||
          !/^(?:isom|iso[0-9]|mp4[12]|avc1|M4V |dash)$/.test(plain.toString("ascii", 8, 12))) throw new IngestionError("INVALID_VIDEO", 422);
    }
    root = unwrapDek(upload.version.wrappedRootKey);
    const index = offset / upload.partBytes, name = sourceName(index);
    const encrypted = sealObject(root, { asset: upload.version.assetId, version: upload.versionId, attempt: upload.id, name }, plain);
    signal?.throwIfAborted();
    try { await storage.put(`${upload.version.storagePrefix}/source/${name}`, Readable.from([encrypted]), encrypted.length); }
    catch (err) {
      if (!(err instanceof StorageError && err.code === "CONFLICT")) throw err;
      const previous = await readSourcePart(storage, upload, index, root, signal);
      try { if (sha256(previous) !== checksum) throw new IngestionError("UPLOAD_CONFLICT"); }
      finally { previous.fill(0); }
    }
    await prisma.$transaction(async tx => {
      await assertLocalBinding(tx, upload.version.asset.mediaId, bindingFrom(upload));
      const n = await tx.$executeRaw`UPDATE "VideoUploadSession" SET
        "receivedBytes" = GREATEST("receivedBytes", ${BigInt(offset + wanted)}),
        "requestToken" = NULL, "requestExpiresAt" = NULL, "updatedAt" = clock_timestamp()
        WHERE id = ${id}::uuid AND status = 'open' AND "requestToken" = ${token}::uuid
          AND "requestExpiresAt" > clock_timestamp() AND "expiresAt" > clock_timestamp()`;
      if (!n) throw new IngestionError("UPLOAD_CLOSED");
    });
    return ownedUpload(id, ownerId);
  } finally {
    plain?.fill(0); root?.fill(0);
    await prisma.videoUploadSession.updateMany({ where: { id, requestToken: token }, data: { requestToken: null, requestExpiresAt: null } });
  }
}
export async function resumeUpload(id: string, ownerId: string, config = videoConfig()) {
  const upload = await ownedUpload(id, ownerId); assertStore(upload, config);
  if (upload.version.sourceCleanedAt || upload.status !== "open" || upload.version.status !== "uploading") throw new IngestionError("UPLOAD_CLOSED");
  const binding = await verifyProductBinding(upload.version.asset.mediaId, upload.productId!);
  // Existing source is safe through product-key rotation, but not if the media
  // DEK/envelope was replaced: its buyer key chain is a different object now.
  if (binding.envelopeId !== upload.envelopeId || binding.envelopeKeyFingerprint !== upload.envelopeKeyFingerprint) throw new IngestionError("KEY_STATE_CHANGED");
  await prisma.$transaction(async tx => {
    await assertLocalBinding(tx, upload.version.asset.mediaId, binding);
    const n = await tx.videoUploadSession.updateMany({ where: { id, ownerId, status: "open", expiresAt: { gt: new Date() } }, data: binding });
    if (!n.count) throw new IngestionError("UPLOAD_CLOSED");
  });
  return ownedUpload(id, ownerId);
}
export async function completeUpload(id: string, ownerId: string, config = videoConfig()) {
  const upload = await ownedUpload(id, ownerId); assertStore(upload, config);
  if (upload.status === "completed") return upload;
  const binding = await verifyProductBinding(upload.version.asset.mediaId, upload.productId!);
  if (JSON.stringify(binding) !== JSON.stringify(bindingFrom(upload))) throw new IngestionError("KEY_STATE_CHANGED");
  await prisma.$transaction(async tx => {
    await assertLocalBinding(tx, upload.version.asset.mediaId, binding);
    const rows = await tx.$queryRaw<{ id: string }[]>`UPDATE "VideoUploadSession" SET status = 'completed', "updatedAt" = clock_timestamp()
      WHERE id = ${id}::uuid AND status = 'open' AND "receivedBytes" = "expectedBytes"
        AND "expiresAt" > clock_timestamp() AND "requestToken" IS NULL RETURNING id`;
    if (!rows.length) throw new IngestionError("UPLOAD_CONFLICT");
    const changed = await tx.videoAssetVersion.updateMany({ where: { id: upload.versionId, status: "uploading" }, data: { status: "queued" } });
    if (!changed.count) throw new IngestionError("UPLOAD_CLOSED");
    await tx.videoJob.create({ data: { kind: "package_asset", versionId: upload.versionId, scope: upload.version.storageIdentity,
      idempotencyKey: `package:${upload.versionId}`, maxAttempts: MAX_ATTEMPTS } });
  });
  return ownedUpload(id, ownerId);
}
export async function abortUpload(id: string, ownerId: string) {
  const upload = await ownedUpload(id, ownerId);
  if (["cancelled", "deleted", "deleting"].includes(upload.version.status)) return upload;
  if (upload.version.status === "ready") throw new IngestionError("UPLOAD_CLOSED");
  await cancelVersion(upload.versionId);
  return ownedUpload(id, ownerId);
}
export async function retryUpload(id: string, ownerId: string, config = videoConfig()) {
  const upload = await ownedUpload(id, ownerId); assertStore(upload, config);
  if (upload.version.sourceCleanedAt || upload.version.cleanupToken) throw new IngestionError("SOURCE_EXPIRED");
  if (upload.status !== "completed" || upload.version.status !== "failed") throw new IngestionError("UPLOAD_CLOSED");
  const binding = await verifyProductBinding(upload.version.asset.mediaId, upload.productId!);
  if (binding.envelopeId !== upload.envelopeId || binding.envelopeKeyFingerprint !== upload.envelopeKeyFingerprint) throw new IngestionError("KEY_STATE_CHANGED");
  await prisma.$transaction(async tx => {
    await lockQuota(tx);
    const current = await tx.$queryRaw<{ sourceCleanedAt: Date | null; cleanupToken: string | null }[]>`SELECT "sourceCleanedAt", "cleanupToken" FROM "VideoAssetVersion" WHERE id = ${upload.versionId}::uuid FOR UPDATE`;
    if (current[0].sourceCleanedAt || current[0].cleanupToken) throw new IngestionError("SOURCE_EXPIRED");
    // Retry adds one attempt and its worst-case output reservation; old attempt
    // bytes stay counted until cleanup. A retry never resets the attempt count.
    const job = await tx.videoJob.findUniqueOrThrow({ where: { versionId: upload.versionId } });
    if (job.status !== "failed" || job.maxAttempts >= 10) throw new IngestionError("UPLOAD_CLOSED");
    const used = await tx.videoAssetVersion.aggregate({ _sum: { reservedBytes: true } });
    if ((used._sum.reservedBytes || BigInt(0)) + BigInt(OUTPUT_BUDGET) > BigInt(ingestionConfig().maxStorageBytes)) throw new IngestionError("STORAGE_QUOTA", 507);
    if (await tx.videoJob.count({ where: { kind: "package_asset", status: { in: ["queued", "running"] } } }) >= ingestionConfig().maxPending) throw new IngestionError("JOB_QUOTA", 429);
    await assertLocalBinding(tx, upload.version.asset.mediaId, binding);
    await tx.videoJob.update({ where: { id: job.id }, data: { status: "queued", maxAttempts: { increment: 1 }, availableAt: new Date(), lastErrorCode: null } });
    await tx.videoUploadSession.update({ where: { id }, data: binding });
    await tx.videoAssetVersion.update({ where: { id: upload.versionId }, data: { status: "queued", progress: 0, reservedBytes: { increment: BigInt(OUTPUT_BUDGET) } } });
  });
  return ownedUpload(id, ownerId);
}
