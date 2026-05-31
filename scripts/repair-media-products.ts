/**
 * Re-key the MediaProduct rows of one or more media after a fresh envelope mint.
 *
 * When a url media is re-saved after the EncryptedEnvelope→MediaEnvelope
 * migration (which left url media envelope-less), the edit page mints a FRESH
 * envelope with a NEW per-media DEK. The existing MediaProduct rows still wrap
 * the OLD value, so a paid buyer's product key recovers the wrong DEK and the
 * viewer shows "Payment received … couldn't unlock the content on this device".
 *
 * This script re-wraps each covering MediaProduct row under the media's current
 * envelope DEK, fetching the product key from SatsRail. The envelope bytes are
 * never touched. Idempotent — safe to re-run.
 *
 * Run it against production with the Railway env injected:
 *   railway run npx tsx scripts/repair-media-products.ts <mediaId>
 *   railway run npx tsx scripts/repair-media-products.ts --all
 *   railway run npx tsx scripts/repair-media-products.ts --all --dry-run
 *
 * Requires DATABASE_URL, CONTENT_KEK (to recover the DEK), and a configured
 * merchant key (to fetch product keys). Pair with `npm run audit:media-envelopes`
 * to find which media need it.
 *
 * Exit codes: 0 = all repaired (or nothing to do), 1 = bad usage / missing config,
 *             3 = one or more rows failed to re-encrypt.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { prisma } from "@/lib/prisma";
import { getMerchantKey } from "@/lib/merchant-key";
import { reencryptMediaProductsForMedia } from "@/lib/media-product-reencrypt";

function parseArgs(argv: string[]) {
  const mediaIds: string[] = [];
  let all = false;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--all") all = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--")) {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    } else mediaIds.push(arg);
  }
  if (all && mediaIds.length > 0) {
    console.error("Pass either explicit media ids OR --all, not both");
    process.exit(1);
  }
  if (!all && mediaIds.length === 0) {
    console.error(
      "Usage: repair-media-products.ts <mediaId>... | --all [--dry-run]"
    );
    process.exit(1);
  }
  return { mediaIds, all, dryRun };
}

async function main() {
  const { mediaIds, all, dryRun } = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  try {
    // --all: every media that has an envelope AND at least one MediaProduct row.
    // (Envelope-less media can't be re-keyed — re-save their URL first; media
    // with no products have nothing to re-wrap.)
    const targets = all
      ? (
          await prisma.media.findMany({
            where: { envelope: { isNot: null }, mediaProducts: { some: {} } },
            select: { id: true },
            orderBy: { id: "asc" },
          })
        ).map((m) => m.id)
      : mediaIds;

    if (targets.length === 0) {
      console.log("Nothing to repair.");
      return;
    }

    if (dryRun) {
      console.log(`[dry-run] ${targets.length} media would be re-keyed:`);
      for (const id of targets) {
        const n = await prisma.mediaProduct.count({ where: { mediaId: id } });
        const hasEnv = await prisma.mediaEnvelope.findUnique({
          where: { mediaId: id },
          select: { id: true },
        });
        console.log(
          `  ${id}  product-wraps=${n}  envelope=${hasEnv ? "yes" : "MISSING (re-save URL first)"}`
        );
      }
      return;
    }

    const sk = await getMerchantKey();
    if (!sk) {
      console.error("Merchant API key not configured (Settings) — cannot fetch product keys");
      process.exit(1);
    }

    let hadErrors = false;
    for (const id of targets) {
      try {
        const r = await reencryptMediaProductsForMedia(id, { sk });
        const status = r.errors.length === 0 ? "ok" : `${r.errors.length} error(s)`;
        console.log(`  ${id}  re-keyed ${r.reencrypted}/${r.total}  [${status}]`);
        for (const e of r.errors) {
          console.log(`      ✗ product ${e.satsrailProductId}: ${e.error}`);
          hadErrors = true;
        }
      } catch (err) {
        hadErrors = true;
        console.log(`  ${id}  FAILED: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }

    if (hadErrors) process.exitCode = 3;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("repair-media-products failed:", err);
  process.exit(1);
});
