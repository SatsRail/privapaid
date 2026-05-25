import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getProductsForMedia } from "@/lib/access-gate";
import { auth } from "@/lib/auth";
import { validateBody, isValidationError, schemas } from "@/lib/validate";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user?.id || session.user.role !== "customer") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await validateBody(req, schemas.flagCreate);
  if (isValidationError(result)) return result;

  const { flag_type } = result;

  const media = await prisma.media.findUnique({
    where: { id },
    select: { id: true, channelId: true },
  });
  if (!media) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }

  // Single source of truth: check both media-level and channel-level products
  const products = await getProductsForMedia(media.id, media.channelId);
  const productIds = products.map((p) => p.productId);

  const hasPurchase =
    productIds.length > 0 &&
    !!(await prisma.purchase.findFirst({
      where: {
        customerId: session.user.id,
        satsrailProductId: { in: productIds },
      },
      select: { id: true },
    }));

  if (!hasPurchase) {
    return NextResponse.json(
      { error: "Purchase required to flag content" },
      { status: 403 }
    );
  }

  try {
    await prisma.flag.create({
      data: {
        mediaId: id,
        customerId: session.user.id,
        flagType: flag_type.trim(),
      },
    });
  } catch (err) {
    // Unique constraint (mediaId, customerId) — already flagged.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json({ error: "Already flagged" }, { status: 409 });
    }
    throw err;
  }

  await prisma.media.update({
    where: { id },
    data: { flagsCount: { increment: 1 } },
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
