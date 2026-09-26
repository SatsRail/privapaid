import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { storageIdentity, type VideoConfig } from "./config";
import { ingestionConfig } from "./ingestion-config";
import type { VideoStorage } from "./storage/types";
// Phase 2 retires staged sources and failed attempts. Paid-version lifecycle,
// backups and arbitrary orphan discovery remain Phase 5 work.
export async function cleanupStaging(storage: VideoStorage, config: VideoConfig) {
  const retention = ingestionConfig().retentionSeconds, token = randomUUID();
  await storage.cleanupTemporary?.(new Date(Date.now() - retention * 1000));
  const candidates = await prisma.$queryRaw<{ id: string }[]>`
    WITH candidate AS (
      SELECT v.id FROM "VideoAssetVersion" v JOIN "VideoUploadSession" u ON u."versionId" = v.id
      WHERE v."formatVersion" = 1 AND v."storageIdentity" = ${storageIdentity(config)} AND v."sourceCleanedAt" IS NULL
        AND (v."cleanupExpiresAt" IS NULL OR v."cleanupExpiresAt" <= clock_timestamp())
        AND ((v.status IN ('ready', 'failed', 'cancelled') AND v."updatedAt" < clock_timestamp() - ${retention} * interval '1 second')
          OR (v.status = 'uploading' AND u."expiresAt" < clock_timestamp() - ${retention} * interval '1 second'))
      ORDER BY v."updatedAt" FOR UPDATE OF v SKIP LOCKED LIMIT 1
    ) UPDATE "VideoAssetVersion" v SET "cleanupToken" = ${token}::uuid,
      "cleanupExpiresAt" = clock_timestamp() + interval '5 minutes',
      status = CASE WHEN v.status = 'uploading' THEN 'cancelled'::"VideoVersionStatus" ELSE v.status END
    FROM candidate WHERE v.id = candidate.id RETURNING v.id`;
  if (!candidates.length) return false;
  const version = await prisma.videoAssetVersion.findUniqueOrThrow({ where: { id: candidates[0].id }, include: { upload: true } });
  try {
    // A cleanup lease blocks retry/resume; cancellation blocks new part writes.
    await prisma.videoUploadSession.updateMany({ where: { versionId: version.id, status: "open" }, data: { status: "aborted" } });
    const keepPrefix = version.status === "ready" && version.manifestKey ? version.manifestKey.slice(0, version.manifestKey.lastIndexOf("/") + 1) : undefined;
    let cursor: string | undefined;
    do {
      const page = await storage.list(version.storagePrefix + "/", 100, cursor);
      for (const object of page.objects) if (!keepPrefix || !object.key.startsWith(keepPrefix)) await storage.delete(object.key);
      cursor = page.cursor;
      const changed = await prisma.$executeRaw`UPDATE "VideoAssetVersion" SET "cleanupExpiresAt" = clock_timestamp() + interval '5 minutes'
        WHERE id = ${version.id}::uuid AND "cleanupToken" = ${token}::uuid AND "cleanupExpiresAt" > clock_timestamp()`;
      if (!changed) return false;
    } while (cursor);
    await prisma.videoAssetVersion.updateMany({ where: { id: version.id, cleanupToken: token }, data: {
      sourceCleanedAt: new Date(), reservedBytes: keepPrefix ? version.encryptedBytes : BigInt(0), cleanupToken: null, cleanupExpiresAt: null,
    } });
    return true;
  } finally {
    await prisma.videoAssetVersion.updateMany({ where: { id: version.id, cleanupToken: token }, data: { cleanupToken: null, cleanupExpiresAt: null } });
  }
}
