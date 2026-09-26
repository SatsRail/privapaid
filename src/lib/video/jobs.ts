import { randomUUID } from "node:crypto";
import { Prisma, type VideoJob, type VideoJobKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export class LeaseLostError extends Error { constructor() { super("VIDEO_LEASE_LOST"); } }
export type Lease = VideoJob & { leaseToken: string; leaseExpiresAt: Date };
export type JobErrorCode = "PROBE_MISMATCH" | import("./ingestion-errors").IngestionCode;
function leaseDuration(seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 15 || seconds > 300) throw new Error("VIDEO_LEASE_INVALID");
}
export async function enqueueProbe(idempotencyKey: string) {
  if (!/^probe:[a-f0-9]{64}:[0-9]{1,12}$/.test(idempotencyKey)) throw new Error("VIDEO_JOB_KEY_INVALID");
  return prisma.videoJob.upsert({ where: { idempotencyKey }, create: { kind: "storage_probe", idempotencyKey }, update: {} });
}

// Postgres is both queue and authority. Every lease check uses database time;
// worker clock skew cannot resurrect a lease. Row locks fence state changes.
export async function claimJob(kinds: VideoJobKind[], seconds: number, scope?: string): Promise<Lease | null> {
  leaseDuration(seconds);
  if (!kinds.length) return null;
  return prisma.$transaction(async tx => {
    const exhausted = await tx.$queryRaw<{ versionId: string | null }[]>`
      WITH exhausted AS (
        SELECT id FROM "VideoJob"
        WHERE kind::text IN (${Prisma.join(kinds)}) AND (${scope || ""} = '' OR (kind = 'storage_probe' AND "idempotencyKey" LIKE ${`probe:${scope}:%`}) OR (kind = 'package_asset' AND scope = ${scope || ""})) AND attempts >= "maxAttempts"
          AND ((status = 'running' AND "leaseExpiresAt" <= clock_timestamp()) OR status = 'queued')
        ORDER BY "availableAt", id FOR UPDATE SKIP LOCKED LIMIT 100
      ) UPDATE "VideoJob" j SET status = 'failed', "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "lastErrorCode" = 'RETRIES_EXHAUSTED', "updatedAt" = clock_timestamp()
      FROM exhausted WHERE j.id = exhausted.id RETURNING j."versionId"`;
    await tx.videoAssetVersion.updateMany({ where: { id: { in: exhausted.flatMap(r => r.versionId ? [r.versionId] : []) }, status: { in: ["queued", "processing"] } }, data: { status: "failed" } });
    const rows = await tx.$queryRaw<Lease[]>`
      WITH candidate AS (
        SELECT id FROM "VideoJob" WHERE kind::text IN (${Prisma.join(kinds)}) AND (${scope || ""} = '' OR (kind = 'storage_probe' AND "idempotencyKey" LIKE ${`probe:${scope}:%`}) OR (kind = 'package_asset' AND scope = ${scope || ""}))
          AND attempts < "maxAttempts" AND (
            (status = 'queued' AND "availableAt" <= clock_timestamp()) OR
            (status = 'running' AND "leaseExpiresAt" <= clock_timestamp()))
        ORDER BY "availableAt", id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE "VideoJob" j SET status = 'running', attempts = attempts + 1,
        "leaseToken" = ${randomUUID()}::uuid,
        "leaseExpiresAt" = clock_timestamp() + ${seconds} * interval '1 second',
        "updatedAt" = clock_timestamp()
      FROM candidate WHERE j.id = candidate.id RETURNING j.*`;
    const job = rows[0];
    if (job?.versionId) await tx.videoAssetVersion.updateMany({ where: { id: job.versionId, status: { in: ["queued", "processing"] } }, data: { status: "processing" } });
    return job || null;
  });
}
export async function heartbeat(job: Lease, seconds: number) {
  leaseDuration(seconds);
  const n = await prisma.$executeRaw`
    UPDATE "VideoJob" SET "leaseExpiresAt" = clock_timestamp() + ${seconds} * interval '1 second', "updatedAt" = clock_timestamp()
    WHERE id = ${job.id}::uuid AND status = 'running' AND "leaseToken" = ${job.leaseToken}::uuid AND "leaseExpiresAt" > clock_timestamp()`;
  if (!n) throw new LeaseLostError();
}
export async function lockLease(tx: Prisma.TransactionClient, job: Lease) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "VideoJob" WHERE id = ${job.id}::uuid AND status = 'running'
      AND "leaseToken" = ${job.leaseToken}::uuid AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE`;
  if (!rows.length) throw new LeaseLostError();
}
export async function completeJob(job: Lease, tx: Prisma.TransactionClient = prisma) {
  const n = await tx.$executeRaw`
    UPDATE "VideoJob" SET status = 'completed', "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = clock_timestamp()
    WHERE id = ${job.id}::uuid AND status = 'running' AND "leaseToken" = ${job.leaseToken}::uuid AND "leaseExpiresAt" > clock_timestamp()`;
  if (!n) throw new LeaseLostError();
}
export async function failJob(job: Lease, code: JobErrorCode, permanent = false) {
  await prisma.$transaction(async tx => {
    await lockLease(tx, job);
    const terminal = permanent || job.attempts >= job.maxAttempts;
    const delay = Math.min(300, 2 ** job.attempts);
    const n = await tx.$executeRaw`
      UPDATE "VideoJob" SET status = ${terminal ? "failed" : "queued"}::"VideoJobStatus",
        "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lastErrorCode" = ${code},
        "availableAt" = clock_timestamp() + ${delay} * interval '1 second', "updatedAt" = clock_timestamp()
      WHERE id = ${job.id}::uuid AND "leaseToken" = ${job.leaseToken}::uuid AND "leaseExpiresAt" > clock_timestamp()`;
    if (!n) throw new LeaseLostError();
    if (job.versionId) await tx.videoAssetVersion.updateMany({ where: { id: job.versionId, status: "processing" }, data: { status: terminal ? "failed" : "queued" } });
  });
}
export function attemptPrefix(job: Lease, versionPrefix?: string) {
  return `${versionPrefix || `probes/${job.id}`}/attempts/${job.leaseToken}`;
}
export async function workerHeartbeat(id: string, storageIdentity: string) {
  await prisma.$executeRaw`INSERT INTO "VideoWorker" (id, "storageIdentity", "lastSeenAt") VALUES (${id}::uuid, ${storageIdentity}, clock_timestamp())
    ON CONFLICT (id) DO UPDATE SET "lastSeenAt" = clock_timestamp()`;
  await prisma.$executeRaw`DELETE FROM "VideoWorker" WHERE "lastSeenAt" < clock_timestamp() - interval '1 day'`;
}
