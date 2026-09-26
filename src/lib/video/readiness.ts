import { prisma } from "@/lib/prisma";
import { videoEnabled, videoConfig, storageIdentity, VideoSetupError } from "./config";
import { videoStorage } from "./storage";
export async function videoReadiness() {
  if (!videoEnabled()) return { enabled: false, ready: false, code: "VIDEO_DISABLED" };
  try {
    const config = videoConfig();
    const scope = storageIdentity(config);
    // Checking the optional schema doesn't affect the existing /api/health.
    let workers: { count: bigint }[];
    try {
      await prisma.videoJob.findFirst({ select: { id: true } });
      workers = await prisma.$queryRaw`SELECT count(*) FROM "VideoWorker" WHERE "storageIdentity" = ${scope} AND "lastSeenAt" > clock_timestamp() - interval '30 seconds'`;
    } catch { return { enabled: true, ready: false, code: "VIDEO_DATABASE_MIGRATION_REQUIRED" }; }
    try { await videoStorage(config).check(); }
    catch { return { enabled: true, ready: false, code: "VIDEO_STORAGE_UNAVAILABLE" }; }
    const probe = await prisma.videoJob.findFirst({ where: { kind: "storage_probe", idempotencyKey: { startsWith: `probe:${scope}:` } }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, updatedAt: true, lastErrorCode: true } });
    const workerCount = Number(workers[0].count);
    const freshProbe = probe?.status === "completed" && Date.now() - probe.updatedAt.getTime() < 3600_000;
    const ready = workerCount > 0 && freshProbe;
    return { enabled: true, ready, provider: config.provider, workerCount, code: !workerCount ? "VIDEO_WORKER_MISSING" : !freshProbe ? "VIDEO_STORAGE_PROBE_REQUIRED" : "VIDEO_FOUNDATIONS_READY", probe };
  } catch (err) {
    return { enabled: true, ready: false, code: err instanceof VideoSetupError ? err.code : "VIDEO_SETUP_UNAVAILABLE" };
  }
}
