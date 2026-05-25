/**
 * Convenience script to run all seed scripts for a fresh deployment.
 *
 * Usage:
 *   npx tsx scripts/seed-all.ts
 *
 * Runs in order:
 *   1. seed-categories.ts (creates PrivaPaid categories)
 *   2. seed-admin.ts (creates superadmin — requires ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD env vars)
 *
 * Requires DATABASE_URL in .env.local or environment.
 * Admin seed requires ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD env vars.
 */

import { execFileSync } from "child_process";
import { resolve } from "path";

const scriptsDir = resolve(__dirname);

const scripts = [
  { name: "seed-categories", file: "seed-categories.ts" },
  { name: "seed-admin", file: "seed-admin.ts" },
];

for (const script of scripts) {
  console.log(`\n--- Running ${script.name} ---\n`);
  try {
    execFileSync("npx", ["tsx", resolve(scriptsDir, script.file)], {
      stdio: "inherit",
      cwd: resolve(scriptsDir, ".."),
    });
  } catch {
    console.error(`\n${script.name} failed. Stopping.`);
    process.exit(1);
  }
}

console.log("\n--- All seeds complete ---");
