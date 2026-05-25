import { prisma } from "@/lib/prisma";

/**
 * Default grace period before an unreferenced encrypted-photo blob is eligible
 * for deletion. The upload → create-media → create-product flow is a few
 * round-trips; an hour is comfortably longer than any realistic admin session
 * but short enough that storage stays clean.
 */
export const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000; // 1 hour

export interface CleanupOptions {
  /**
   * Only delete files older than this many milliseconds. Defaults to 1 hour.
   * Pass `0` to delete every unreferenced file regardless of age (use with care).
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
  errors: Array<{ blobId: string; error: string }>;
}

/**
 * Scan the EncryptedPhotoBlob table and remove any ciphertext row that has no
 * `Media` row pointing at it (photo media stores the blob id in
 * `Media.blob.blobId`). Skips rows younger than `graceMs` so an in-progress
 * upload isn't deleted out from under the admin before they finish creating
 * the Media row + first product wrap.
 *
 * Why this matters: the upload endpoint persists ciphertext before the admin
 * has committed to creating a Media row. If the admin abandons the flow, the
 * bytes stay forever. They're unrecoverable without the DEK (which was never
 * persisted), so they're not a security risk — just dead storage.
 */
export async function cleanupOrphanEncryptedPhotos(
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
      select: { id: true, createdAt: true },
    };
    const batch: Array<{ id: string; createdAt: Date }> =
      await prisma.encryptedPhotoBlob.findMany(args);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const blob of batch) {
      result.scanned++;

      const referenced = await prisma.media.findFirst({
        where: {
          mediaType: "photo",
          blob: { path: ["blobId"], equals: blob.id },
        },
        select: { id: true },
      });
      if (referenced) {
        result.referenced++;
        continue;
      }

      result.orphaned++;

      const uploadedAt = blob.createdAt.getTime();
      if (uploadedAt && now - uploadedAt < graceMs) {
        result.skippedYoung++;
        continue;
      }

      if (dryRun) continue;

      try {
        await prisma.encryptedPhotoBlob.delete({ where: { id: blob.id } });
        result.deleted++;
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        result.errors.push({ blobId: blob.id, error: message });
      }
    }
  }

  return result;
}
