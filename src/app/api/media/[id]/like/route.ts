import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { getProductsForMedia, verifyMacaroonAccess } from "@/lib/access-gate";
import Media from "@/models/Media";
import Customer from "@/models/Customer";
import { auth } from "@/lib/auth";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { rateLimit } from "@/lib/rate-limit";

// Like toggle endpoint. ActionRow tracks per-user like state in
// localStorage and sends `{ action: "like" | "unlike" }` whenever the
// user flips it. Server applies the +1 / -1 delta.
//
// Gated behind payment — same access logic as comments and flags:
//   1. Authenticated customer with a purchase record for one of this
//      media's products, OR
//   2. Macaroon-based proof of payment (anonymous payers).
// Anything else returns 401. Liking content you haven't paid for would
// pollute the engagement counter and let a non-payer drive the count
// arbitrarily through the rate-limit ceiling.
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

  await connectDB();

  // Verify media exists up-front so we can use its channel for product lookup.
  const media = await Media.findById(id);
  if (!media) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }

  // Single source of truth for product lookup — same call comments uses.
  const products = await getProductsForMedia(String(media._id), String(media.channel_id));
  const productIds = products.map((p) => p.productId);

  // Path 1: Logged-in customer with purchase record.
  let allowed = false;
  const session = await auth();
  if (session?.user?.id && session.user.role === "customer") {
    const customer = await Customer.findById(session.user.id)
      .select("purchases")
      .lean();
    allowed = !!customer?.purchases?.some(
      (p) => productIds.includes(p.satsrail_product_id)
    );
  }

  // Path 2: Macaroon-based proof of payment (anonymous payers).
  if (!allowed) {
    const access = await verifyMacaroonAccess(productIds);
    allowed = access.granted;
  }

  if (!allowed) {
    return NextResponse.json(
      { error: "Payment required to like" },
      { status: 401 }
    );
  }

  if (action === "like") {
    const updated = await Media.findByIdAndUpdate(
      id,
      { $inc: { likes_count: 1 } },
      { new: true }
    );
    // Media existed at the top of the handler and the rate-limit
    // window is short; treat a missing doc here as a race we let
    // surface as a generic 404.
    if (!updated) {
      return NextResponse.json({ error: "Media not found" }, { status: 404 });
    }
    return NextResponse.json({ likes_count: updated.likes_count });
  }

  // unlike — conditional decrement so the counter never goes below 0.
  const updated = await Media.findOneAndUpdate(
    { _id: id, likes_count: { $gt: 0 } },
    { $inc: { likes_count: -1 } },
    { new: true }
  );

  if (updated) {
    return NextResponse.json({ likes_count: updated.likes_count });
  }

  // Counter is already at 0 — return the current value (0). Media
  // existence was already verified above, so we don't re-check.
  return NextResponse.json({ likes_count: media.likes_count });
}
