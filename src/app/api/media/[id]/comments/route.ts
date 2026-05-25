import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getProductsForMedia, verifyMacaroonAccess } from "@/lib/access-gate";
import { auth } from "@/lib/auth";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { rateLimit } from "@/lib/rate-limit";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const comments = await prisma.comment.findMany({
    where: { mediaId: id },
    orderBy: { createdAt: "desc" },
    include: { customer: { select: { nickname: true } } },
  });

  const serialized = comments.map((c) => ({
    _id: c.id,
    body: c.body,
    created_at: c.createdAt.toISOString(),
    customer: {
      nickname: c.nickname || c.customer?.nickname || "Anonymous",
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

  // Verify media exists
  const media = await prisma.media.findUnique({
    where: { id },
    select: { id: true, channelId: true },
  });
  if (!media) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }

  // Single source of truth for product lookup
  const products = await getProductsForMedia(media.id, media.channelId);
  const productIds = products.map((p) => p.productId);

  // Path 1: Logged-in customer with purchase record
  const session = await auth();
  if (session?.user?.id && session.user.role === "customer") {
    const customer = await prisma.customer.findUnique({
      where: { id: session.user.id },
      select: {
        nickname: true,
        purchases: {
          where: { satsrailProductId: { in: productIds } },
          select: { id: true },
          take: 1,
        },
      },
    });
    const hasPurchase = !!customer && customer.purchases.length > 0;

    if (hasPurchase) {
      // Authenticated customers post under their registered nickname.
      // Ignoring submittedNickname here prevents impersonation
      // ("ElonMusk", "AdminBob") and prevents nickname-flipping per
      // comment as an obfuscation tactic.
      const nickname =
        customer?.nickname || session.user.name || "Anonymous";
      const comment = await prisma.comment.create({
        data: {
          mediaId: id,
          customerId: session.user.id,
          nickname,
          body: body.trim(),
        },
      });
      await prisma.media.update({
        where: { id },
        data: { commentsCount: { increment: 1 } },
      });

      return NextResponse.json(
        {
          _id: comment.id,
          body: comment.body,
          created_at: comment.createdAt.toISOString(),
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

  const comment = await prisma.comment.create({
    data: {
      mediaId: id,
      nickname: submittedNickname,
      body: body.trim(),
    },
  });

  await prisma.media.update({
    where: { id },
    data: { commentsCount: { increment: 1 } },
  });

  return NextResponse.json(
    {
      _id: comment.id,
      body: comment.body,
      created_at: comment.createdAt.toISOString(),
      customer: { nickname: submittedNickname },
    },
    { status: 201 }
  );
}
