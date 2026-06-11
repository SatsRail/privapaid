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

import { prisma } from "@/lib/prisma";
import { decryptSecretKey } from "@/lib/encryption";

/**
 * Surface media that can never decrypt: a Media row with no envelope, or a
 * linked envelope whose wrappedDek is NULL (legacy pre-migration url media).
 * Both render the "temporarily unavailable" wall for every viewer, yet the
 * app boots and serves traffic happily — so without this warning an operator
 * only finds out from support tickets. Never blocks boot; remediation is
 * re-import / re-saving the source URL (see scripts/audit-media-envelopes.ts).
 */
export async function warnOnBrokenMediaEnvelopes(): Promise<void> {
  let missingEnvelope: number;
  let missingWrappedDek: number;
  try {
    [missingEnvelope, missingWrappedDek] = await Promise.all([
      prisma.media.count({ where: { envelope: null } }),
      prisma.mediaEnvelope.count({
        where: { mediaId: { not: null }, wrappedDek: null },
      }),
    ]);
  } catch (err) {
    console.warn(
      "startup-checks: Postgres unreachable, skipping media-envelope probe",
      err instanceof Error ? err.message : err
    );
    return;
  }

  if (missingEnvelope > 0 || missingWrappedDek > 0) {
    console.warn(
      `startup-checks: ${missingEnvelope + missingWrappedDek} media cannot decrypt ` +
        `(${missingEnvelope} without an envelope, ${missingWrappedDek} without a wrapped DEK). ` +
        "Affected media show 'temporarily unavailable' to viewers. " +
        "Run `npx tsx scripts/audit-media-envelopes.ts` to list them; " +
        "re-import the channel or re-save each media's source URL to fix."
    );
  }

  if (!process.env.CONTENT_KEK && (missingEnvelope > 0 || missingWrappedDek > 0)) {
    console.warn(
      "startup-checks: CONTENT_KEK is not set — remediation will fail until it is, " +
        "because every envelope mint wraps the DEK under CONTENT_KEK."
    );
  }
}

export async function checkEncryptionKeyMatchesDb(): Promise<void> {
  // Only meaningful if there's an existing encrypted key to trial-decrypt.
  // On a brand-new install (no setup completed) there's nothing to check.
  let settings: { satsrailApiKeyEncrypted: string | null } | null;
  try {
    settings = await prisma.settings.findFirst({
      select: { satsrailApiKeyEncrypted: true },
    });
  } catch (err) {
    // If Postgres isn't reachable at startup, leave that for the existing
    // connection-error handling to surface. Don't block boot on it.
    console.warn(
      "startup-checks: Postgres unreachable, skipping encryption-key probe",
      err instanceof Error ? err.message : err
    );
    return;
  }

  const ciphertext = settings?.satsrailApiKeyEncrypted;
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
