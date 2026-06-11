import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getProductsForMedia, verifyMacaroonAccess } from "@/lib/access-gate";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { rateLimit } from "@/lib/rate-limit";

// Anonymous comments on a media item.
//
// GET — public list, newest first. Pagination via ?page=&limit=.
// POST — gated behind payment via macaroon. Body-only; we don't track
// authors. Counter on Media is denormalized for fast list rendering.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const comments = await prisma.comment.findMany({
    where: { mediaId: id, media: { deletedAt: null } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, mediaId: true, body: true, createdAt: true },
  });
  return NextResponse.json({
    data: comments.map((c) => ({
      id: c.id,
      media_id: c.mediaId,
      body: c.body,
      created_at: c.createdAt,
    })),
  });
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

  const { body } = validated;

  const media = await prisma.media.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, channelId: true },
  });
  if (!media) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }

  const products = await getProductsForMedia(media.id, media.channelId);
  const productIds = products.map((p) => p.productId);
  const access = await verifyMacaroonAccess(productIds);
  if (!access.granted) {
    return NextResponse.json(
      { error: "Payment required to comment" },
      { status: 401 }
    );
  }

  const [comment] = await prisma.$transaction([
    prisma.comment.create({
      data: { mediaId: id, body },
      select: { id: true, mediaId: true, body: true, createdAt: true },
    }),
    prisma.media.update({
      where: { id },
      data: { commentsCount: { increment: 1 } },
    }),
  ]);

  return NextResponse.json(
    {
      id: comment.id,
      media_id: comment.mediaId,
      body: comment.body,
      created_at: comment.createdAt,
    },
    { status: 201 }
  );
}
