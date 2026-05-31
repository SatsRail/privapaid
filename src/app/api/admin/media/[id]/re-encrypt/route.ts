import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { getMerchantKey } from "@/lib/merchant-key";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { reencryptMediaProductsForMedia } from "@/lib/media-product-reencrypt";

/**
 * POST /api/admin/media/[id]/re-encrypt
 *
 * Re-wrap this media's MediaProduct rows under its CURRENT envelope DEK, so a
 * paying buyer's product key recovers the right key. The self-serve repair for
 * "Payment received … couldn't unlock the content on this device" — typically
 * after re-saving a url media's source (a fresh envelope = a new DEK that the
 * old per-product wraps no longer match). The envelope bytes are never touched;
 * idempotent, safe to click more than once.
 *
 * Owner-gated (matches the product re-encrypt route). Returns the per-media
 * summary so the button can report partial failures (e.g. SatsRail unreachable
 * for one product) and the admin can retry.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireOwnerApi();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  const sk = await getMerchantKey();
  if (!sk) {
    return NextResponse.json(
      { error: "Merchant API key not configured" },
      { status: 422 }
    );
  }

  let result;
  try {
    result = await reencryptMediaProductsForMedia(id, { sk });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (/not found/i.test(message)) {
      return NextResponse.json({ error: "Media not found" }, { status: 404 });
    }
    if (/no envelope/i.test(message)) {
      return NextResponse.json(
        { error: "This media has no envelope yet — save its source URL first." },
        { status: 422 }
      );
    }
    // Most likely a CONTENT_KEK problem unwrapping the DEK. Don't echo the raw
    // crypto error (it can carry key lengths / byte offsets); surface a generic
    // hint and log only the error name.
    console.error(
      `media.reencrypt ${id}: failed (${err instanceof Error ? err.name : "unknown"})`
    );
    return NextResponse.json(
      { error: "Failed to re-encrypt — check CONTENT_KEK configuration" },
      { status: 500 }
    );
  }

  // A clean re-key means any `error` flag (a buyer-confirmed undecryptable blob)
  // is now stale — lift it so the admin doesn't have to also "Mark resolved".
  // Non-fatal: a failure here must not fail the repair the admin just ran.
  if (result.errors.length === 0 && result.total > 0) {
    try {
      await prisma.media.updateMany({
        where: { id, status: "error" },
        data: { status: "ok", statusReason: null, statusChangedAt: new Date() },
      });
    } catch (err) {
      console.error(`media.reencrypt ${id}: failed to clear error status:`, err);
    }
  }

  await audit({
    actorId: auth.id,
    actorEmail: auth.email,
    actorType: "admin",
    action: "media.reencrypt",
    targetType: "media",
    targetId: id,
    details: {
      total: result.total,
      reencrypted: result.reencrypted,
      errors: result.errors.length,
    },
  });

  return NextResponse.json(result);
}
