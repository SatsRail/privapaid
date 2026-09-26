import { claimJob } from "../../src/lib/video/jobs";
// Crash-test child: stops immediately after a real durable claim. The parent
// kills only this owned process, then verifies the restarted worker's fence.
claimJob(["storage_probe"], 15).then(job => {
  process.send?.(job);
  setInterval(() => {}, 1000);
}).catch(() => process.exit(1));
