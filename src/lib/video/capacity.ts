import { prisma } from "@/lib/prisma";
import { ingestionConfig } from "./ingestion-config";
import { videoReadiness } from "./readiness";
export async function videoCapacity() {
  const config = ingestionConfig();
  const [readiness, totals, states] = await Promise.all([
    videoReadiness(), prisma.videoAssetVersion.aggregate({ _sum: { reservedBytes: true, encryptedBytes: true }, _count: true }),
    prisma.videoAssetVersion.groupBy({ by: ["status"], _count: true }),
  ]);
  const counts = Object.fromEntries(states.map(row => [row.status, row._count]));
  return { readiness: { ready: readiness.ready, code: readiness.code, workerCount: "workerCount" in readiness ? readiness.workerCount : 0 },
    versions: totals._count, encryptedOutputBytes: String(totals._sum.encryptedBytes || 0), reservedBytes: String(totals._sum.reservedBytes || 0),
    storageBudgetBytes: String(config.maxStorageBytes), pending: (counts.uploading || 0) + (counts.queued || 0) + (counts.processing || 0),
    maxPending: config.maxPending, queued: counts.queued || 0, processing: counts.processing || 0, maxTransfers: config.maxTransfers };
}
export type VideoCapacity = Awaited<ReturnType<typeof videoCapacity>>;
