/**
 * Startup probe that runs once during `instrumentation.register`.
 *
 * Why: env-check.ts validates that SK_ENCRYPTION_KEY exists and is well-formed.
 * It does NOT verify the key matches the ciphertext already in the database.
 * If a deploy rotates SK_ENCRYPTION_KEY by mistake (or fails to mount the
 * volume that holds the auto-generated key), the app will start successfully
 * and only fail later when the first request tries to call SatsRail. By then
 * the operator may have already restarted again, and the chain becomes
 * harder to diagnose.
 *
 * This probe attempts a trial decrypt of the stored merchant key. If it
 * fails in production, we exit(1) before serving any traffic. In dev/test
 * we log a warning and continue so local workflows aren't blocked.
 */

import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import Settings from "@/models/Settings";
import { decryptSecretKey } from "@/lib/encryption";

export async function checkEncryptionKeyMatchesDb(): Promise<void> {
  // Only meaningful if there's an existing encrypted key to trial-decrypt.
  // On a brand-new install (no setup completed) there's nothing to check.
  // Reuse an existing mongoose connection if tests (or another runtime) have
  // already opened one — connectDB() reads MONGODB_URI fresh and would not
  // see test-time memory-server URIs that were dialed directly.
  if (mongoose.connection.readyState !== 1) {
    try {
      await connectDB();
    } catch (err) {
      // If Mongo isn't reachable at startup, leave that for the existing
      // connection-error handling to surface. Don't block boot on it.
      console.warn(
        "startup-checks: MongoDB unreachable, skipping encryption-key probe",
        err instanceof Error ? err.message : err
      );
      return;
    }
  }

  const settings = await Settings.findOne()
    .select("satsrail_api_key_encrypted")
    .lean();

  const ciphertext = settings?.satsrail_api_key_encrypted;
  if (!ciphertext) return;

  try {
    decryptSecretKey(ciphertext);
  } catch (err) {
    const message =
      "FATAL: SK_ENCRYPTION_KEY does not decrypt the stored merchant key.\n" +
      "This usually means the key was regenerated, the volume holding\n" +
      ".generated-env was lost, or the wrong key was passed in env.\n" +
      "Refusing to start — restore the original key or restore from backup.";

    if (process.env.NODE_ENV === "production") {
      console.error(message);
      console.error("Underlying error:", err instanceof Error ? err.message : err);
      process.exit(1);
    } else {
      console.warn(
        "startup-checks (non-production):",
        message,
        "\nUnderlying error:",
        err instanceof Error ? err.message : err
      );
    }
  }
}
