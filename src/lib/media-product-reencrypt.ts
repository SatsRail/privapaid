import { prisma } from "@/lib/prisma";
import { satsrail } from "@/lib/satsrail";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { dekBase64urlFromEnvelope } from "@/lib/media-envelope";

export interface MediaReencryptResult {
  mediaId: string;
  /** MediaProduct rows covering this media. */
  total: number;
  /** Rows successfully re-wrapped under the current envelope DEK. */
  reencrypted: number;
  /** Per-product failures (SatsRail key fetch or DB write). */
  errors: { satsrailProductId: string; error: string }[];
}

/**
 * Re-wrap every MediaProduct row of `mediaId` under the media's CURRENT envelope
 * DEK, using each covering product's SatsRail key.
 *
 * Why this exists: minting a FRESH MediaEnvelope (e.g. re-saving a url media's
 * source after the EncryptedEnvelope→MediaEnvelope migration, which left url
 * media envelope-less) generates a NEW per-media DEK. The existing MediaProduct
 * rows still wrap the OLD value (pre-migration, url rows even wrapped the URL
 * itself), so a buyer's product key recovers the wrong DEK and decryption fails
 * with "couldn't unlock the content on this device". Re-wrapping the rows under
 * the new DEK restores the buyer path. The envelope bytes are never touched.
 *
 * Recovering the DEK needs CONTENT_KEK (via MediaEnvelope.wrappedDek); fetching
 * the product keys needs a merchant key (`sk`). Idempotent: re-running re-wraps
 * the same DEK again (a fresh IV each time), so it's safe to retry after a
 * partial failure. Each distinct product key is fetched at most once.
 */
export async function reencryptMediaProductsForMedia(
  mediaId: string,
  opts: { sk: string }
): Promise<MediaReencryptResult> {
  const media = await prisma.media.findUnique({
    where: { id: mediaId },
    select: { envelope: { select: { wrappedDek: true } } },
  });
  if (!media) throw new Error(`Media ${mediaId} not found`);
  if (!media.envelope) throw new Error(`Media ${mediaId} has no envelope`);

  // Recover the media DEK from its CONTENT_KEK-wrapped copy. Throws if
  // CONTENT_KEK is missing/rotated — surfaced to the caller, not swallowed.
  const dekBase64url = dekBase64urlFromEnvelope(media.envelope);

  const rows = await prisma.mediaProduct.findMany({
    where: { mediaId },
    select: { id: true, product: { select: { satsrailProductId: true } } },
  });

  const result: MediaReencryptResult = {
    mediaId,
    total: rows.length,
    reencrypted: 0,
    errors: [],
  };

  const keyByProduct = new Map<string, string>();
  for (const row of rows) {
    const pid = row.product.satsrailProductId;
    try {
      let key = keyByProduct.get(pid);
      if (!key) {
        key = (await satsrail.getProductKey(opts.sk, pid)).key;
        keyByProduct.set(pid, key);
      }
      const encryptedDek = encryptSourceUrl(dekBase64url, key, pid);
      await prisma.mediaProduct.update({
        where: { id: row.id },
        data: { encryptedDek },
      });
      result.reencrypted++;
    } catch (err) {
      result.errors.push({
        satsrailProductId: pid,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  return result;
}
