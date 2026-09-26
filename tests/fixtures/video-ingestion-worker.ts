import { prisma } from "../../src/lib/prisma";
import { videoConfig, storageIdentity } from "../../src/lib/video/config";
import { videoStorage } from "../../src/lib/video/storage";
import { runNextJob } from "../../src/lib/video/worker";
async function main() {
  const config = videoConfig(), storage = videoStorage(config); await storage.check();
  if (process.argv.includes("--crash-boundary")) {
    const put = storage.put.bind(storage); let seen = false;
    storage.put = async (key, body, bytes) => {
      await put(key, body, bytes);
      if (!seen && key.endsWith(".m4s")) { seen = true; process.send?.({ outputWritten: true }); await new Promise(() => {}); }
    };
  }
  await runNextJob(storage, 15, undefined, storageIdentity(config), config);
  process.send?.({ done: true, maxRSSKiB: process.resourceUsage().maxRSS });
  await prisma.$disconnect(); process.disconnect?.();
}
main().catch(async () => { await prisma.$disconnect(); process.exit(1); });
