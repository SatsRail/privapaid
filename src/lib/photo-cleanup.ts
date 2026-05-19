import { ObjectId } from "mongodb";
import { getEncryptedPhotosBucket } from "@/lib/gridfs";
import Media from "@/models/Media";

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
  errors: Array<{ gridFsId: string; error: string }>;
}

/**
 * Scan the `encrypted_photos` GridFS bucket and remove any ciphertext file that
 * has no `Media` row pointing at it (photo media stores the GridFS file id in
 * `source_url`). Skips files younger than `graceMs` so an in-progress upload
 * isn't deleted out from under the admin before they finish creating the Media
 * row + first product wrap.
 *
 * Why this matters: the upload endpoint persists ciphertext before the admin
 * has committed to creating a Media row. If the admin abandons the flow, the
 * bytes stay in GridFS forever. They're unrecoverable without the DEK (which
 * was never persisted), so they're not a security risk — just dead storage.
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

  const bucket = await getEncryptedPhotosBucket();

  // Stream the file index — for typical instances this is small (one entry per
  // surviving photo), so cursoring keeps memory bounded if it ever grows.
  const cursor = bucket.find({});
  for await (const file of cursor) {
    result.scanned++;
    const fileId = file._id as ObjectId;
    const fileIdStr = fileId.toString();

    // A Media row holds the GridFS id as its source_url for photo media.
    // findOne returns null if no row references this file.
    const referenced = await Media.exists({
      media_type: "photo",
      source_url: fileIdStr,
    });
    if (referenced) {
      result.referenced++;
      continue;
    }

    result.orphaned++;

    const uploadedAt = file.uploadDate ? new Date(file.uploadDate).getTime() : 0;
    if (uploadedAt && now - uploadedAt < graceMs) {
      result.skippedYoung++;
      continue;
    }

    if (dryRun) continue;

    try {
      await bucket.delete(fileId);
      result.deleted++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      result.errors.push({ gridFsId: fileIdStr, error: message });
    }
  }

  return result;
}
