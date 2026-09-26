import { randomBytes, randomUUID } from "node:crypto";
import type { VideoStorageProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { wrapDek } from "@/lib/content-dek";
import { attemptPrefix, completeJob, lockLease, type Lease } from "./jobs";
import { validateKey } from "./storage/types";

// Internal foundation for Phase 2; deliberately not an upload endpoint yet.
// Browser input never supplies a provider prefix, key, or wrapped key.
export async function createUpload(input: { mediaId: string; ownerId: string; expectedBytes: bigint; provider: VideoStorageProvider; segmentSeconds: 4 | 10 }) {
  if (!input.ownerId || input.ownerId.length > 128 || input.expectedBytes < BigInt(1) || input.expectedBytes > BigInt(10 * 1024 ** 3) || ![4, 10].includes(input.segmentSeconds)) throw new Error("VIDEO_UPLOAD_INVALID");
  const root = randomBytes(32);
  let wrappedRootKey: string;
  try { wrappedRootKey = wrapDek(root); } finally { root.fill(0); }
  return prisma.$transaction(async tx => {
    const media = await tx.media.findFirst({ where: { id: input.mediaId, mediaType: "video", deletedAt: null }, select: { id: true } });
    if (!media) throw new Error("VIDEO_MEDIA_NOT_FOUND");
    const asset = await tx.videoAsset.upsert({ where: { mediaId: media.id }, create: { mediaId: media.id }, update: { generation: { increment: 0 } } });
    const next = await tx.videoAsset.update({ where: { id: asset.id }, data: { generation: { increment: 1 } } });
    const id = randomUUID();
    return tx.videoAssetVersion.create({ data: {
      id, assetId: asset.id, generation: next.generation, provider: input.provider,
      storagePrefix: `assets/${asset.id}/versions/${id}`, wrappedRootKey,
      // The format is still experimental until Phase 0 qualification closes.
      formatVersion: 0, encodingProfile: "h264-aac-720p-experimental", segmentSeconds: input.segmentSeconds,
      upload: { create: { ownerId: input.ownerId, expectedBytes: input.expectedBytes, expiresAt: new Date(Date.now() + 24 * 3600_000) } },
    }, include: { upload: true } });
  });
}
export async function queueUploadedVersion(versionId: string, ownerId: string) {
  return prisma.$transaction(async tx => {
    const uploads = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status FROM "VideoUploadSession" WHERE "versionId" = ${versionId}::uuid AND "ownerId" = ${ownerId}
        AND "expiresAt" > clock_timestamp() AND "receivedBytes" = "expectedBytes" AND "sourceSha256" IS NOT NULL FOR UPDATE`;
    if (!uploads.length) throw new Error("VIDEO_UPLOAD_INCOMPLETE");
    if (uploads[0].status === "completed") return tx.videoJob.findUniqueOrThrow({ where: { versionId } });
    if (uploads[0].status !== "open") throw new Error("VIDEO_UPLOAD_CLOSED");
    const n = await tx.videoAssetVersion.updateMany({ where: { id: versionId, status: "uploading" }, data: { status: "queued" } });
    if (!n.count) throw new Error("VIDEO_STATE_CONFLICT");
    await tx.videoUploadSession.update({ where: { id: uploads[0].id }, data: { status: "completed" } });
    return tx.videoJob.create({ data: { kind: "package_asset", versionId, idempotencyKey: `package:${versionId}` } });
  });
}
export type ReadyOutput = { manifestKey: string; manifestSha256: string; objectCount: number; encryptedBytes: bigint; durationMs: bigint };
// Phase 2 must authenticate and validate the full object/timeline set before
// calling this. This function handles durable metadata and fencing only.
export async function recordReadyVersion(job: Lease, output: ReadyOutput) {
  if (job.kind !== "package_asset" || !job.versionId || !/^[a-f0-9]{64}$/.test(output.manifestSha256) ||
      !Number.isInteger(output.objectCount) || output.objectCount < 1 || output.objectCount > 100000 ||
      output.encryptedBytes < BigInt(1) || output.encryptedBytes > BigInt(100 * 1024 ** 3) ||
      output.durationMs < BigInt(1) || output.durationMs > BigInt(24 * 3600_000)) throw new Error("VIDEO_OUTPUT_INVALID");
  validateKey(output.manifestKey);
  await prisma.$transaction(async tx => {
    await lockLease(tx, job);
    const version = await tx.videoAssetVersion.findUniqueOrThrow({ where: { id: job.versionId! } });
    if (version.status !== "processing" || !output.manifestKey.startsWith(attemptPrefix(job, version.storagePrefix) + "/")) throw new Error("VIDEO_OUTPUT_INVALID");
    await tx.videoAssetVersion.update({ where: { id: version.id }, data: { ...output, status: "ready", progress: 100, readyAt: new Date() } });
    // Recheck time at commit boundary, rolling back ALL metadata on expiry.
    await completeJob(job, tx);
  });
}
// Publication is deliberately a separate operation. The future ingestion
// orchestrator must also validate product association/rotation before calling.
export async function publishVersion(versionId: string): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const version = await tx.videoAssetVersion.findUniqueOrThrow({ where: { id: versionId } });
    await tx.$queryRaw`SELECT id FROM "VideoAsset" WHERE id = ${version.assetId}::uuid FOR UPDATE`;
    const changed = await tx.$executeRaw`
      UPDATE "VideoAsset" a SET "publishedVersionId" = v.id, "updatedAt" = clock_timestamp()
      FROM "VideoAssetVersion" v JOIN "VideoJob" j ON j."versionId" = v.id
      WHERE a.id = ${version.assetId}::uuid AND v.id = ${versionId}::uuid AND v.status = 'ready'
        AND j.status = 'completed' AND a.generation = v.generation`;
    return changed === 1;
  });
}
export async function cancelVersion(versionId: string) {
  await prisma.$transaction(async tx => {
    // Lock jobs first, matching completion/claim ordering.
    await tx.videoJob.updateMany({ where: { versionId, status: { in: ["queued", "running"] } }, data: { status: "cancelled", leaseToken: null, leaseExpiresAt: null } });
    const n = await tx.videoAssetVersion.updateMany({ where: { id: versionId, status: { in: ["uploading", "queued", "processing", "failed"] } }, data: { status: "cancelled" } });
    if (!n.count) throw new Error("VIDEO_STATE_CONFLICT");
    await tx.videoUploadSession.updateMany({ where: { versionId, status: "open" }, data: { status: "aborted" } });
  });
}
export async function beginVersionDeletion(versionId: string) {
  await prisma.$transaction(async tx => {
    await tx.videoJob.updateMany({ where: { versionId, status: { in: ["queued", "running"] } }, data: { status: "cancelled", leaseToken: null, leaseExpiresAt: null } });
    await tx.videoAsset.updateMany({ where: { publishedVersionId: versionId }, data: { publishedVersionId: null } });
    await tx.videoAssetVersion.updateMany({ where: { id: versionId, status: { not: "deleted" } }, data: { status: "deleting" } });
    await tx.videoUploadSession.updateMany({ where: { versionId, status: "open" }, data: { status: "aborted" } });
  });
}
export async function listAssets(limit = 25, cursor?: string) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor && !/^[a-f0-9-]{36}$/.test(cursor))) throw new Error("VIDEO_PAGE_INVALID");
  const rows = await prisma.videoAsset.findMany({
    where: cursor ? { id: { gt: cursor } } : {}, take: limit + 1, orderBy: { id: "asc" },
    select: { id: true, mediaId: true, generation: true, publishedVersionId: true,
      versions: { take: 1, orderBy: { generation: "desc" }, select: { id: true, status: true, progress: true, encryptedBytes: true, objectCount: true } } },
  });
  const items = rows.slice(0, limit).map(r => ({ ...r, versions: r.versions.map(v => ({ ...v, encryptedBytes: v.encryptedBytes.toString() })) }));
  return { items, cursor: rows.length > limit ? items.at(-1)!.id : null };
}
