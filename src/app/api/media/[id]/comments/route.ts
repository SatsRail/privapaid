import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { getProductsForMedia, verifyMacaroonAccess } from "@/lib/access-gate";
import Comment from "@/models/Comment";
import Media from "@/models/Media";
import Customer from "@/models/Customer";
import { auth } from "@/lib/auth";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { rateLimit } from "@/lib/rate-limit";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await connectDB();

  const comments = await Comment.find({ media_id: id })
    .populate("customer_id", "nickname")
    .sort({ created_at: -1 })
    .lean();

  const serialized = comments.map((c) => ({
    _id: String(c._id),
    body: c.body,
    created_at: c.created_at.toISOString(),
    customer: {
      nickname:
        c.nickname ||
        (c.customer_id as { nickname?: string })?.nickname ||
        "Anonymous",
    },
  }));

  return NextResponse.json(serialized);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const limited = await rateLimit("comment", 10);
  if (limited) return limited;

  const validated = await validateBody(req, schemas.commentCreate);
  if (isValidationError(validated)) return validated;

  const { body, nickname: submittedNickname } = validated;

  await connectDB();

  // Verify media exists
  const media = await Media.findById(id);
  if (!media) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }

  // Single source of truth for product lookup
  const products = await getProductsForMedia(String(media._id), String(media.channel_id));
  const productIds = products.map((p) => p.productId);

  // Path 1: Logged-in customer with purchase record
  const session = await auth();
  if (session?.user?.id && session.user.role === "customer") {
    const customer = await Customer.findById(session.user.id)
      .select("purchases nickname")
      .lean();
    const hasPurchase = customer?.purchases?.some(
      (p) => productIds.includes(p.satsrail_product_id)
    );

    if (hasPurchase) {
      // Authenticated customers post under their registered nickname.
      // Ignoring submittedNickname here prevents impersonation
      // ("ElonMusk", "AdminBob") and prevents nickname-flipping per
      // comment as an obfuscation tactic.
      const nickname =
        customer?.nickname || session.user.name || "Anonymous";
      const comment = await Comment.create({
        media_id: id,
        customer_id: session.user.id,
        nickname,
        body: body.trim(),
      });
      await Media.findByIdAndUpdate(id, { $inc: { comments_count: 1 } });

      return NextResponse.json(
        {
          _id: String(comment._id),
          body: comment.body,
          created_at: comment.created_at.toISOString(),
          customer: { nickname },
        },
        { status: 201 }
      );
    }
  }

  // Path 2: Macaroon-based proof of payment (anonymous payers)
  const access = await verifyMacaroonAccess(productIds);

  if (!access.granted) {
    return NextResponse.json(
      { error: "Payment required to comment" },
      { status: 401 }
    );
  }

  // Macaroon verified — nickname is required for anonymous payers
  if (!submittedNickname) {
    return NextResponse.json(
      { error: "Nickname required" },
      { status: 400 }
    );
  }

  const comment = await Comment.create({
    media_id: id,
    nickname: submittedNickname,
    body: body.trim(),
  });

  await Media.findByIdAndUpdate(id, { $inc: { comments_count: 1 } });

  return NextResponse.json(
    {
      _id: String(comment._id),
      body: comment.body,
      created_at: comment.created_at.toISOString(),
      customer: { nickname: submittedNickname },
    },
    { status: 201 }
  );
}
