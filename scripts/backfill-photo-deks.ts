/**
 * Populate Media.encrypted_dek for legacy photos that pre-date the
 * KEK-wrapped DEK field.
 *
 * For each photo Media without encrypted_dek, find any MediaProduct,
 * recover the DEK by decrypting its encrypted_source_url with the product
 * key from SatsRail, then wrap the recovered DEK under PHOTO_KEK and save
 * it on the Media doc.
 *
 * Usage:
 *   npx tsx scripts/backfill-photo-deks.ts             # do the backfill
 *   npx tsx scripts/backfill-photo-deks.ts --dry-run   # report only
 *
 * Idempotent — re-running skips photos that already have encrypted_dek.
 *
 * Exit codes:
 *   0 — success (including "nothing to do")
 *   1 — required env missing (MONGODB_URI / PHOTO_KEK / merchant key)
 *   2 — at least one photo failed (e.g., no MediaProduct, SatsRail
 *       rejected the key fetch). The rest of the run still proceeds so a
 *       single bad row doesn't block the whole backfill.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import mongoose from "mongoose";
import Media from "@/models/Media";
import MediaProduct from "@/models/MediaProduct";
import { satsrail } from "@/lib/satsrail";
import { decryptSourceUrl } from "@/lib/content-encryption";
import { wrapDekFromBase64url } from "@/lib/photo-dek";
import { getMerchantKey } from "@/lib/merchant-key";

function parseArgs(argv: string[]) {
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

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set");
    process.exit(1);
  }
  if (!process.env.PHOTO_KEK) {
    console.error("PHOTO_KEK is not set — generate one with `openssl rand -base64 32`");
    process.exit(1);
  }

  await mongoose.connect(uri);
  try {
    const sk = await getMerchantKey();
    if (!sk) {
      console.error("Merchant API key is not configured");
      process.exit(1);
    }

    const photos = await Media.find({
      media_type: "photo",
      $or: [{ encrypted_dek: { $exists: false } }, { encrypted_dek: null }],
    })
      .select("_id")
      .lean();

    console.log(`Found ${photos.length} photo(s) without encrypted_dek`);

    let updated = 0;
    let skipped = 0;
    const errors: Array<{ mediaId: string; reason: string }> = [];

    // Cache product keys — many photos share the same MediaProduct in
    // practice, and the SatsRail call is the slow part of the loop.
    const keyCache = new Map<string, string>();
    const getKey = async (satsrailProductId: string): Promise<string> => {
      const cached = keyCache.get(satsrailProductId);
      if (cached) return cached;
      const { key } = await satsrail.getProductKey(sk, satsrailProductId);
      keyCache.set(satsrailProductId, key);
      return key;
    };

    for (const photo of photos) {
      const mediaId = String(photo._id);
      try {
        const mp = await MediaProduct.findOne({ media_id: photo._id })
          .select("satsrail_product_id encrypted_source_url")
          .lean();
        if (!mp) {
          errors.push({ mediaId, reason: "no MediaProduct — cannot recover DEK" });
          continue;
        }

        const otherKey = await getKey(mp.satsrail_product_id);
        const dekBase64url = decryptSourceUrl(
          mp.encrypted_source_url,
          otherKey,
          mp.satsrail_product_id
        );

        if (dryRun) {
          console.log(`[dry-run] would wrap DEK for ${mediaId} (via ${mp.satsrail_product_id})`);
        } else {
          const wrapped = wrapDekFromBase64url(dekBase64url);
          await Media.updateOne({ _id: photo._id }, { $set: { encrypted_dek: wrapped } });
        }
        updated++;
      } catch (err) {
        errors.push({
          mediaId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    skipped = photos.length - updated - errors.length;

    console.log(
      JSON.stringify(
        {
          ok: errors.length === 0,
          dryRun,
          totalPhotos: photos.length,
          updated,
          skipped,
          errorCount: errors.length,
          errors: errors.slice(0, 20),
        },
        null,
        2
      )
    );

    if (errors.length > 0) process.exitCode = 2;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("backfill-photo-deks failed:", err);
  process.exit(1);
});
