/**
 * Delete encrypted photo blobs that no Media row references.
 *
 * Usage:
 *   npx tsx scripts/cleanup-orphan-photos.ts                # default: 1h grace
 *   npx tsx scripts/cleanup-orphan-photos.ts --grace 0      # delete all orphans
 *   npx tsx scripts/cleanup-orphan-photos.ts --dry-run      # report only
 *   npx tsx scripts/cleanup-orphan-photos.ts --grace 86400 --dry-run
 *
 * Suitable for a daily cron. Exits 0 on success (including "nothing to do"),
 * 1 if DATABASE_URL is missing, 2 if any individual delete failed (the rest of
 * the run still proceeds — non-fatal so cron logs surface but don't escalate).
 *
 * Idempotent: safe to run as often as you like.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { prisma } from "@/lib/prisma";
import {
  cleanupOrphanEncryptedPhotos,
  DEFAULT_ORPHAN_GRACE_MS,
} from "@/lib/photo-cleanup";

function parseArgs(argv: string[]) {
  let graceMs = DEFAULT_ORPHAN_GRACE_MS;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--grace") {
      const next = argv[++i];
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0) {
        console.error(`Invalid --grace value: ${next} (expected seconds, >= 0)`);
        process.exit(1);
      }
      graceMs = parsed * 1000;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return { graceMs, dryRun };
}

async function main() {
  const { graceMs, dryRun } = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  try {
    const start = Date.now();
    const result = await cleanupOrphanEncryptedPhotos({ graceMs, dryRun });
    const elapsedMs = Date.now() - start;

    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun,
          graceSeconds: graceMs / 1000,
          elapsedMs,
          ...result,
        },
        null,
        2
      )
    );

    if (result.errors.length > 0) {
      process.exitCode = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("cleanup-orphan-photos failed:", err);
  process.exit(1);
});
