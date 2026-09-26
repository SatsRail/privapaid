import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { prisma } from "@/lib/prisma";
import { videoConfig, storageIdentity, VideoSetupError } from "@/lib/video/config";
import { videoStorage } from "@/lib/video/storage";
import { workerHeartbeat } from "@/lib/video/jobs";
import { cleanupStaging } from "@/lib/video/cleanup";
import { runNextJob } from "@/lib/video/worker";

const healthFile = "/tmp/privapaid-video-worker-health.json";
async function main() {
  if (process.argv.includes("--healthcheck")) {
    const { at } = JSON.parse(await readFile(healthFile, "utf8"));
    if (!Number.isFinite(at) || Date.now() - at > 30000) throw new Error("WORKER_STALE");
    return;
  }
  const config = videoConfig();
  const storage = videoStorage(config);
  await storage.check();
  const id = randomUUID();
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  // Heartbeats represent a process connected to DB with validated storage config.
  // The encrypted probe is the stronger end-to-end storage readiness check.
  const pulse = async () => {
    await workerHeartbeat(id, storageIdentity(config));
    await writeFile(healthFile, JSON.stringify({ at: Date.now() }), { mode: 0o600 });
  };
  await pulse();
  let pulsing = false;
  const timer = setInterval(async () => {
    if (pulsing) return;
    pulsing = true;
    try { await pulse(); } catch { shutdown.abort(); }
    finally { pulsing = false; }
  }, 5000);
  console.info(JSON.stringify({ event: "video_worker_started", workerId: id, provider: config.provider }));
  let lastCleanup = 0;
  try {
    do {
      if (Date.now() - lastCleanup > 60000) {
        lastCleanup = Date.now();
        await cleanupStaging(storage, config);
      }
      const worked = await runNextJob(storage, config.leaseSeconds, shutdown.signal, storageIdentity(config), config);
      if (process.argv.includes("--once")) break;
      if (!worked && !shutdown.signal.aborted) await sleep(1000, undefined, { signal: shutdown.signal }).catch(() => {});
    } while (!shutdown.signal.aborted);
  } finally {
    clearInterval(timer);
    await prisma.videoWorker.deleteMany({ where: { id } });
    await prisma.$disconnect();
  }
}
main().catch(async err => {
  // Never emit SDK/Prisma exceptions containing connection strings or paths.
  console.error(JSON.stringify({ event: "video_worker_failed", code: err instanceof VideoSetupError ? err.code : "VIDEO_WORKER_UNAVAILABLE" }));
  await prisma.$disconnect();
  process.exitCode = 1;
});
