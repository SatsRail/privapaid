import { prisma } from "@/lib/prisma";

/**
 * Default grace period before an unreferenced encrypted envelope row is
 * eligible for deletion. The upload → create-media → create-product flow is a
 * few round-trips; an hour is comfortably longer than any realistic admin
 * session but short enough that storage stays clean.
 */
export const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000; // 1 hour

export interface CleanupOptions {
  /**
   * Only delete rows older than this many milliseconds. Defaults to 1 hour.
   * Pass `0` to delete every unreferenced row regardless of age (use with care).
   */
  graceMs?: number;
  /**
   * If true, log what would be deleted but don't actually delete. Defaults to false.
   */
  dryRun?: boolean;
}

export interface CleanupResult {
  scanned: number;
  referenced: number;
  orphaned: number;
  deleted: number;
  skippedYoung: number;
  errors: Array<{ envelopeId: string; error: string }>;
}

/**
 * Scan the MediaEnvelope table for unlinked rows (mediaId IS NULL) and remove
 * them. A linked envelope (mediaId set) is the live content for its Media; an
 * unlinked one is a staged photo upload whose Media was never created. Skips
 * rows younger than `graceMs` so an in-progress upload isn't deleted before the
 * admin finishes creating the Media row + first product wrap.
 *
 * Why this matters: /api/admin/photos persists ciphertext before the admin has
 * committed to creating a Media row. If the admin abandons the flow, the bytes
 * stay forever. They're unrecoverable without the DEK (the raw DEK was never
 * persisted), so they're not a security risk — just dead storage.
 */
export async function cleanupOrphanEnvelopes(
  options: CleanupOptions = {}
): Promise<CleanupResult> {
  const graceMs = options.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const dryRun = options.dryRun ?? false;
  const now = Date.now();
  const result: CleanupResult = {
    scanned: 0,
    referenced: 0,
    orphaned: 0,
    deleted: 0,
    skippedYoung: 0,
    errors: [],
  };

  // Stream rows page-by-page to bound memory if the table ever grows.
  const PAGE = 500;
  let cursor: string | undefined = undefined;
  while (true) {
    const args = {
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" as const },
      where: { mediaId: null },
      select: { id: true, createdAt: true },
    };
    const batch: Array<{ id: string; createdAt: Date }> =
      await prisma.mediaEnvelope.findMany(args);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const envelope of batch) {
      // Only unlinked rows reach here (mediaId IS NULL), so every one is orphaned.
      result.scanned++;
      result.orphaned++;

      const uploadedAt = envelope.createdAt.getTime();
      if (uploadedAt && now - uploadedAt < graceMs) {
        result.skippedYoung++;
        continue;
      }

      if (dryRun) continue;

      try {
        await prisma.mediaEnvelope.delete({ where: { id: envelope.id } });
        result.deleted++;
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        result.errors.push({ envelopeId: envelope.id, error: message });
      }
    }
  }

  return result;
}
