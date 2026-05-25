/**
 * Rotate SK_ENCRYPTION_KEY — the envelope key that protects every
 * Settings.satsrailApiKeyEncrypted row.
 *
 * Reads OLD_SK_ENCRYPTION_KEY and NEW_SK_ENCRYPTION_KEY from env,
 * decrypts each encrypted merchant key with the old key, re-encrypts
 * with the new key, and writes the new ciphertext back. Idempotent
 * within a run: if a row was already rewrapped (e.g., a previous
 * partial run touched it), the old-key decrypt fails and the script
 * reports the row as needing manual review rather than corrupting it.
 *
 * Usage:
 *   OLD_SK_ENCRYPTION_KEY=<64hex> \
 *   NEW_SK_ENCRYPTION_KEY=<64hex> \
 *   DATABASE_URL=postgres://... \
 *   npx tsx scripts/rotate-encryption-key.ts            # apply
 *
 *   OLD_SK_ENCRYPTION_KEY=... NEW_SK_ENCRYPTION_KEY=... \
 *   npx tsx scripts/rotate-encryption-key.ts --dry-run  # report only
 *
 * After a successful run, set SK_ENCRYPTION_KEY=$NEW_SK_ENCRYPTION_KEY
 * in your runtime env, restart the app, and verify the startup-checks
 * probe at src/lib/startup-checks.ts decrypts successfully.
 *
 * Exit codes:
 *   0 — success (every row rewrapped, or nothing to do)
 *   1 — required env missing or invalid (64-hex check fails)
 *   2 — at least one row failed to decrypt with the OLD key. The
 *       script reports the row IDs so an operator can investigate.
 *       Nothing is written for failed rows.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";

interface Args {
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return { dryRun };
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;

function loadKeyOrExit(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) {
    console.error(`FATAL: ${name} is required (64-character hex string).`);
    process.exit(1);
  }
  if (!HEX_64.test(raw)) {
    console.error(`FATAL: ${name} must be exactly 64 hex characters (256-bit key).`);
    process.exit(1);
  }
  return Buffer.from(raw, "hex");
}

function decryptWithKey(envelope: string, key: Buffer): string {
  const parts = envelope.split(":");
  if (parts.length !== 3 || parts[0].length === 0 || parts[1].length === 0) {
    throw new Error("malformed envelope (expected iv:authTag:ciphertext)");
  }
  const [ivHex, authTagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  const oldKey = loadKeyOrExit("OLD_SK_ENCRYPTION_KEY");
  const newKey = loadKeyOrExit("NEW_SK_ENCRYPTION_KEY");
  if (oldKey.equals(newKey)) {
    console.error("FATAL: OLD_SK_ENCRYPTION_KEY and NEW_SK_ENCRYPTION_KEY are identical.");
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error("FATAL: DATABASE_URL is required.");
    process.exit(1);
  }

  console.log(dryRun ? "rotate-encryption-key (DRY RUN)" : "rotate-encryption-key");

  const rows = await prisma.settings.findMany({
    where: {
      NOT: [
        { satsrailApiKeyEncrypted: null },
        { satsrailApiKeyEncrypted: "" },
      ],
    },
    select: { id: true, satsrailApiKeyEncrypted: true },
  });

  console.log(`Found ${rows.length} settings row(s) with an encrypted merchant key.`);

  let ok = 0;
  let failed = 0;
  const failures: { id: string; reason: string }[] = [];

  for (const row of rows) {
    const id = String(row.id);
    const envelope = row.satsrailApiKeyEncrypted as string;

    let plaintext: string;
    try {
      plaintext = decryptWithKey(envelope, oldKey);
    } catch (err) {
      failed++;
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ id, reason });
      console.error(`  ✗ ${id}: failed to decrypt with OLD key (${reason})`);
      continue;
    }

    const newEnvelope = encryptWithKey(plaintext, newKey);

    if (!dryRun) {
      // Wrap the per-row rewrite in a transaction so a mid-flight failure
      // can't leave a half-written envelope. The update is a single row but
      // the transaction boundary makes the intent explicit and protects
      // against future expansion (e.g., re-encrypting related product blobs
      // under the same key).
      await prisma.$transaction([
        prisma.settings.update({
          where: { id: row.id },
          data: { satsrailApiKeyEncrypted: newEnvelope },
        }),
      ]);
    }
    ok++;
    console.log(`  ✓ ${id}: ${dryRun ? "would rewrap" : "rewrapped"}`);
  }

  await prisma.$disconnect();

  console.log("");
  console.log(`Summary: ${ok} rewrapped, ${failed} failed.`);
  if (failed > 0) {
    console.log("Rows that failed (likely already rotated, corrupted, or wrong OLD key):");
    for (const f of failures) console.log(`  ${f.id}: ${f.reason}`);
    process.exit(2);
  }
  if (dryRun) {
    console.log("Dry run — no rows were modified. Re-run without --dry-run to apply.");
  } else {
    console.log("");
    console.log("Next steps:");
    console.log("  1. Set SK_ENCRYPTION_KEY=$NEW_SK_ENCRYPTION_KEY in runtime env.");
    console.log("  2. Restart the app.");
    console.log("  3. Verify the startup probe (src/lib/startup-checks.ts) does NOT");
    console.log("     log a decrypt failure.");
    console.log("  4. Once verified, scrub OLD_SK_ENCRYPTION_KEY from your secret store.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("rotate-encryption-key crashed:", err);
  process.exit(1);
});
