/**
 * Audit MediaEnvelope health across every Media row.
 *
 * Invariant: every Media has exactly one MediaEnvelope holding its encrypted
 * payload. The EncryptedEnvelope→MediaEnvelope migration backfilled photo/article
 * media in-SQL, but url media (video/audio/podcast) were NOT — they were meant
 * to be re-imported, because their source URL is not recoverable in-DB (the old
 * Media.blob plaintext was dropped). Any url media left without an envelope
 * renders the "temporarily unavailable" wall.
 *
 * This script surfaces exactly which media are broken and why, so an operator
 * can drive remediation (re-import the channel, or re-enter the source URL on the
 * edit page — which now mints a fresh envelope) and confirm CONTENT_KEK is wired
 * up. CONTENT_KEK is now REQUIRED for ALL media; without it no envelope can be
 * minted or decrypted.
 *
 * Read-only — never mutates. Safe to run against production.
 *
 * Usage:
 *   npx tsx scripts/audit-media-envelopes.ts                # human-readable report
 *   npx tsx scripts/audit-media-envelopes.ts --json         # machine-readable
 *   npx tsx scripts/audit-media-envelopes.ts --deep         # also decrypt each
 *                                                            # envelope (verifies
 *                                                            # CONTENT_KEK + bytes)
 *   npx tsx scripts/audit-media-envelopes.ts --broken-only  # omit the healthy list
 *
 * Exit codes: 0 = every media healthy, 1 = DATABASE_URL missing,
 *             3 = one or more media are broken (a monitoring/CI signal).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { prisma } from "@/lib/prisma";
import {
  decryptEnvelopePayload,
  dekBase64urlFromEnvelope,
} from "@/lib/media-envelope";

type Reason = "ok" | "no-envelope" | "no-wrapped-dek" | "decrypt-failed";

interface Row {
  mediaId: string;
  name: string;
  mediaType: string;
  channelSlug: string | null;
  reason: Reason;
  /**
   * Count of MediaProduct rows (per-product DEK wraps). Re-saving the URL on an
   * envelope-less media mints a FRESH DEK, so any existing MediaProduct rows go
   * stale (they wrap the old DEK). 0 ⇒ URL re-entry is a complete fix; >0 ⇒ a
   * re-import (or a follow-up product re-encrypt) is also needed for buyers to
   * decrypt.
   */
  productWraps: number;
}

const REMEDIATION: Record<Exclude<Reason, "ok">, string> = {
  "no-envelope":
    "no MediaEnvelope — re-import the channel, or open the media's edit page and re-save its source URL (mints a fresh envelope)",
  "no-wrapped-dek":
    "envelope exists but wrappedDek is NULL — re-save the source URL to re-mint, or restore from backup",
  "decrypt-failed":
    "envelope present but won't decrypt — CONTENT_KEK is missing/rotated, or the bytes are corrupted",
};

function parseArgs(argv: string[]) {
  let json = false;
  let deep = false;
  let brokenOnly = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "--deep") deep = true;
    else if (arg === "--broken-only") brokenOnly = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return { json, deep, brokenOnly };
}

function classify(
  envelope: { wrappedDek: string | null; bytes?: Uint8Array } | null,
  kekSet: boolean,
  deep: boolean
): Reason {
  if (!envelope) return "no-envelope";
  if (!envelope.wrappedDek) return "no-wrapped-dek";
  // Without CONTENT_KEK we can't verify decryptability — report the envelope as
  // present but unverified (the run-level warning makes this explicit). Probing
  // the KEK here would mislabel every healthy envelope as decrypt-failed.
  if (!kekSet) return "ok";
  try {
    if (deep) {
      decryptEnvelopePayload(
        envelope as { bytes: Uint8Array; wrappedDek: string }
      );
    } else {
      // Cheapest CONTENT_KEK health probe: unwrap the DEK only.
      dekBase64urlFromEnvelope(envelope);
    }
    return "ok";
  } catch {
    return "decrypt-failed";
  }
}

async function main() {
  const { json, deep, brokenOnly } = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const kekSet = !!process.env.CONTENT_KEK;

  try {
    const media = await prisma.media.findMany({
      select: {
        id: true,
        name: true,
        mediaType: true,
        channel: { select: { slug: true } },
        envelope: {
          select: { id: true, wrappedDek: true, ...(deep ? { bytes: true } : {}) },
        },
        _count: { select: { mediaProducts: true } },
      },
      orderBy: [{ channel: { slug: "asc" } }, { position: "asc" }],
    });

    const rows: Row[] = media.map((m) => ({
      mediaId: m.id,
      name: m.name,
      mediaType: m.mediaType,
      channelSlug: m.channel?.slug ?? null,
      reason: classify(m.envelope, kekSet, deep),
      productWraps: m._count.mediaProducts,
    }));

    const broken = rows.filter((r) => r.reason !== "ok");
    const counts = rows.reduce<Record<Reason, number>>(
      (acc, r) => ({ ...acc, [r.reason]: (acc[r.reason] ?? 0) + 1 }),
      { ok: 0, "no-envelope": 0, "no-wrapped-dek": 0, "decrypt-failed": 0 }
    );

    // Per-channel broken counts make re-import targeting obvious.
    const brokenByChannel = broken.reduce<Record<string, number>>((acc, r) => {
      const k = r.channelSlug ?? "(no channel)";
      return { ...acc, [k]: (acc[k] ?? 0) + 1 };
    }, {});

    if (json) {
      console.log(
        JSON.stringify(
          {
            contentKekSet: kekSet,
            deepVerified: deep && kekSet,
            total: rows.length,
            counts,
            brokenByChannel,
            broken,
            ...(brokenOnly ? {} : { media: rows }),
          },
          null,
          2
        )
      );
    } else {
      const tick = (n: number) => (n > 0 ? `\x1b[31m${n}\x1b[0m` : `${n}`);
      console.log("MediaEnvelope audit");
      console.log(
        `  CONTENT_KEK : ${kekSet ? "set" : "\x1b[31mNOT SET\x1b[0m — envelope decryptability NOT verified"}`
      );
      console.log(
        `  verify mode : ${kekSet ? (deep ? "deep (full payload decrypt)" : "shallow (DEK unwrap)") : "skipped (no KEK)"}`
      );
      console.log(`  media total : ${rows.length}`);
      console.log(`  healthy     : ${counts.ok}`);
      console.log(`  broken      : ${tick(broken.length)}`);
      console.log(`    no-envelope    : ${tick(counts["no-envelope"])}`);
      console.log(`    no-wrapped-dek : ${tick(counts["no-wrapped-dek"])}`);
      console.log(`    decrypt-failed : ${tick(counts["decrypt-failed"])}`);

      if (broken.length > 0) {
        console.log("\n  broken by channel:");
        for (const [slug, n] of Object.entries(brokenByChannel).sort(
          (a, b) => b[1] - a[1]
        )) {
          console.log(`    ${n.toString().padStart(4)}  ${slug}`);
        }
        console.log("\n  broken media:");
        for (const r of broken) {
          const wraps =
            r.productWraps > 0
              ? `  \x1b[33m[${r.productWraps} product wrap(s) — needs re-import/re-encrypt too]\x1b[0m`
              : "";
          console.log(
            `    [${r.channelSlug ?? "—"}] ${r.mediaId}  (${r.mediaType})  ${JSON.stringify(r.name)}  →  ${r.reason}${wraps}`
          );
        }
        console.log("\n  remediation:");
        for (const reason of Object.keys(REMEDIATION) as Array<
          Exclude<Reason, "ok">
        >) {
          if (counts[reason] > 0) {
            console.log(`    ${reason}: ${REMEDIATION[reason]}`);
          }
        }
        const withProducts = broken.filter((r) => r.productWraps > 0).length;
        if (withProducts > 0) {
          console.log(
            `    products: ${withProducts} broken media still have MediaProduct rows that wrap the OLD DEK.` +
              "\n      Re-saving the URL mints a fresh DEK and un-bricks rendering, but those rows go stale —" +
              "\n      re-import the channel (rebuilds the wraps via SatsRail) or re-encrypt the product afterward."
          );
        }
        if (!kekSet) {
          console.log(
            "\n  \x1b[33mwarning:\x1b[0m CONTENT_KEK is not set in this environment. Set it before" +
              "\n  re-importing or re-saving any media — every envelope mint calls wrapDek(CONTENT_KEK)."
          );
        }
      } else if (!brokenOnly) {
        console.log("\n  all media have a healthy envelope ✓");
      }
    }

    if (broken.length > 0) process.exitCode = 3;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("audit-media-envelopes failed:", err);
  process.exit(1);
});
