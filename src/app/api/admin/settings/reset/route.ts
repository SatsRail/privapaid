import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { clearConfigCache } from "@/config/instance";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const CONFIRM_PHRASE = "RESET";

export async function POST(request: Request) {
  const authResult = await requireOwnerApi();
  if (authResult instanceof NextResponse) return authResult;

  let body: { confirm?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  if (body.confirm !== CONFIRM_PHRASE) {
    return NextResponse.json(
      { error: `You must send { "confirm": "${CONFIRM_PHRASE}" } to proceed` },
      { status: 400 }
    );
  }

  try {
    // Audit BEFORE wiping — this log entry will be deleted too,
    // but it captures intent in case the audit table is backed up
    audit({
      actorId: authResult.id,
      actorEmail: authResult.email,
      actorType: "admin",
      action: "settings.factory_reset",
      targetType: "settings",
      details: { warning: "Full data wipe initiated" },
    });

    // Wipe every application table. Order matters where foreign keys are
    // Restrict (Media → Channel, MediaEncryptedBlob → Media). DELETEs in
    // a single transaction so a mid-flight failure can't leave us with
    // half-deleted state.
    //
    // We list these explicitly rather than using TRUNCATE so that the
    // Settings row stays gone (no auto-recreate via @default) and the app
    // returns to the setup wizard cleanly.
    const truncated: string[] = [];

    await prisma.$transaction(async (tx) => {
      // Children first (Restrict / Cascade leafs)
      await tx.comment.deleteMany({}); truncated.push("Comment");
      await tx.mediaEncryptedBlob.deleteMany({}); truncated.push("MediaEncryptedBlob");
      await tx.product.deleteMany({}); truncated.push("Product");
      await tx.media.deleteMany({}); truncated.push("Media");
      await tx.encryptedPhotoBlob.deleteMany({}); truncated.push("EncryptedPhotoBlob");
      await tx.channel.deleteMany({}); truncated.push("Channel");
      await tx.category.deleteMany({}); truncated.push("Category");
      await tx.webhookEvent.deleteMany({}); truncated.push("WebhookEvent");
      await tx.auditLog.deleteMany({}); truncated.push("AuditLog");
      await tx.admin.deleteMany({}); truncated.push("Admin");
      await tx.settings.deleteMany({}); truncated.push("Settings");

      // Reset the autoincrement sequences so a factory-reset instance starts
      // from ch_1 / md_1 again. Without this, refs would keep climbing across
      // a wipe. We look up the sequence name via pg_get_serial_sequence so
      // the code is agnostic to case-folding differences between manual
      // CREATE SEQUENCE and Postgres's `SERIAL` auto-naming.
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"Channel"', 'ref'), 1, false)`
      );
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"Media"', 'ref'), 1, false)`
      );
    });

    // Clear cached config so the app returns to setup mode
    clearConfigCache();

    return NextResponse.json({
      reset: true,
      // Legacy field name kept for client compatibility.
      collections_dropped: truncated,
    });
  } catch (error) {
    console.error("Factory reset error:", error);
    return NextResponse.json(
      { error: "Failed to reset application" },
      { status: 500 }
    );
  }
}
