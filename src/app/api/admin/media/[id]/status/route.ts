import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/admin/media/[id]/status — owner-only manual reset of the Part B
 * decrypt-error flag. Body: { status: "ok" }.
 *
 * Surfaced as "Mark resolved" on the media edit page. The flag normally
 * auto-clears when the blob is re-encrypted (see products/[id]/re-encrypt),
 * but this gives the owner a manual override for a false flag or after an
 * out-of-band fix. It ONLY flips error → ok; it never sets `error` — that
 * direction is server-confirmed exclusively via /api/media/[id]/report-error.
 */
export async function POST(req: Request, context: RouteContext) {
  const auth = await requireOwnerApi();
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;

  let body: { status?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.status !== "ok") {
    return NextResponse.json(
      { error: 'Only { status: "ok" } is accepted' },
      { status: 400 }
    );
  }

  const media = await prisma.media.findUnique({
    where: { id },
    select: { id: true, status: true, statusReason: true },
  });
  if (!media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Idempotent — already clear, nothing to audit.
  if (media.status === "ok") {
    return NextResponse.json({ data: { id: media.id, status: "ok" } });
  }

  const updated = await prisma.media.update({
    where: { id },
    data: { status: "ok", statusReason: null, statusChangedAt: new Date() },
    select: { id: true, status: true },
  });

  audit({
    actorId: auth.id,
    actorEmail: auth.email,
    actorType: "admin",
    action: "media.status_reset",
    targetType: "media",
    targetId: id,
    details: {
      from: "error",
      to: "ok",
      clearedReason: media.statusReason ?? undefined,
    },
  });

  return NextResponse.json({ data: updated });
}
