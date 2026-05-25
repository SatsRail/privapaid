import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getProductsForMedia, verifyMacaroonAccess } from "@/lib/access-gate";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { rateLimit } from "@/lib/rate-limit";

// Like toggle endpoint. ActionRow tracks per-user like state in
// localStorage and sends `{ action: "like" | "unlike" }` whenever the
// user flips it. Server applies the +1 / -1 delta.
//
// Gated behind payment via macaroon-based proof of payment. Liking
// content you haven't paid for would pollute the engagement counter
// and let a non-payer drive the count arbitrarily through the
// rate-limit ceiling.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const limited = await rateLimit("like", 30);
  if (limited) return limited;

  const validated = await validateBody(req, schemas.likeAction);
  if (isValidationError(validated)) return validated;

  const { action } = validated;

  // Verify media exists up-front so we can use its channel for product lookup.
  const media = await prisma.media.findUnique({
    where: { id },
    select: { id: true, channelId: true, likesCount: true },
  });
  if (!media) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }

  // Single source of truth for product lookup.
  const products = await getProductsForMedia(media.id, media.channelId);
  const productIds = products.map((p) => p.productId);

  const access = await verifyMacaroonAccess(productIds);

  if (!access.granted) {
    return NextResponse.json(
      { error: "Payment required to like" },
      { status: 401 }
    );
  }

  if (action === "like") {
    try {
      const updated = await prisma.media.update({
        where: { id },
        data: { likesCount: { increment: 1 } },
        select: { likesCount: true },
      });
      return NextResponse.json({ likes_count: updated.likesCount });
    } catch {
      // Media existed at the top of the handler and the rate-limit
      // window is short; treat a missing doc here as a race we let
      // surface as a generic 404.
      return NextResponse.json({ error: "Media not found" }, { status: 404 });
    }
  }

  // unlike — conditional decrement so the counter never goes below 0.
  const result = await prisma.media.updateMany({
    where: { id, likesCount: { gt: 0 } },
    data: { likesCount: { decrement: 1 } },
  });

  if (result.count > 0) {
    const fresh = await prisma.media.findUnique({
      where: { id },
      select: { likesCount: true },
    });
    return NextResponse.json({ likes_count: fresh?.likesCount ?? 0 });
  }

  // Counter is already at 0 — return the current value (0). Media
  // existence was already verified above, so we don't re-check.
  return NextResponse.json({ likes_count: media.likesCount });
}
