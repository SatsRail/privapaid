import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import {
  cleanupOrphanEnvelopes,
  DEFAULT_ORPHAN_GRACE_MS,
} from "@/lib/envelope-cleanup";

/**
 * POST /api/admin/photos/cleanup
 *
 * Owner-only. Scans the `EncryptedEnvelope` table and deletes any ciphertext
 * row with no Media row pointing at it. Same primitive as the
 * `scripts/cleanup-orphan-envelopes.ts` cron — exposed here for ad-hoc runs
 * from the admin dashboard. Route path is historical ("photos") but covers
 * all envelope-encrypted content (photos and articles).
 *
 * Body (all fields optional):
 *   { graceSeconds?: number, dryRun?: boolean }
 *
 * - graceSeconds defaults to 3600 (1 hour). Pass 0 to delete every orphan
 *   regardless of age (use with care — could wipe a row currently being
 *   uploaded if you race the admin).
 * - dryRun reports what would be deleted without touching anything.
 */
export async function POST(req: NextRequest) {
  const auth = await requireOwnerApi();
  if (auth instanceof NextResponse) return auth;

  let body: { graceSeconds?: unknown; dryRun?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — use defaults
  }

  const graceMs =
    typeof body.graceSeconds === "number" && body.graceSeconds >= 0
      ? body.graceSeconds * 1000
      : DEFAULT_ORPHAN_GRACE_MS;
  const dryRun = body.dryRun === true;

  try {
    const result = await cleanupOrphanEnvelopes({ graceMs, dryRun });

    if (!dryRun && result.deleted > 0) {
      audit({
        actorId: auth.id,
        actorEmail: auth.email,
        actorType: "admin",
        action: "envelopes.cleanup",
        targetType: "encrypted_envelope",
        targetId: "all",
        details: {
          graceSeconds: graceMs / 1000,
          scanned: result.scanned,
          deleted: result.deleted,
          orphaned: result.orphaned,
          errors: result.errors.length,
        },
      });
    }

    return NextResponse.json({
      data: {
        dryRun,
        graceSeconds: graceMs / 1000,
        ...result,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Cleanup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
