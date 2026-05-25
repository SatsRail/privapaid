import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireCustomerApi } from "@/lib/auth-helpers";
import { satsrail } from "@/lib/satsrail";
import { decryptSecretKey } from "@/lib/encryption";
import { validateBody, isValidationError, schemas } from "@/lib/validate";

export async function GET() {
  const session = await requireCustomerApi();
  if (session instanceof NextResponse) return session;

  const purchases = await prisma.purchase.findMany({
    where: { customerId: session.id },
    orderBy: { purchasedAt: "desc" },
  });

  // Preserve the legacy embedded-array shape used by the client.
  const shaped = purchases.map((p) => ({
    satsrail_order_id: p.satsrailOrderId,
    satsrail_product_id: p.satsrailProductId,
    purchased_at: p.purchasedAt,
  }));

  return NextResponse.json({ purchases: shaped });
}

export async function POST(req: NextRequest) {
  const session = await requireCustomerApi();
  if (session instanceof NextResponse) return session;

  const result = await validateBody(req, schemas.customerPurchase);
  if (isValidationError(result)) return result;

  const { order_id, product_id } = result;

  const customer = await prisma.customer.findUnique({
    where: { id: session.id },
    select: { id: true },
  });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // Check for duplicate purchase. Was previously a scan over the embedded
  // purchases[] array; now a cheap indexed lookup on the Purchase table.
  const alreadyPurchased = await prisma.purchase.findFirst({
    where: { customerId: session.id, satsrailProductId: product_id },
    select: { id: true },
  });
  if (alreadyPurchased) {
    return NextResponse.json({ error: "Already purchased" }, { status: 409 });
  }

  // Verify the order against SatsRail (skip for "from_checkout" — macaroon already verified)
  if (order_id !== "from_checkout") {
    try {
      const settings = await prisma.settings.findFirst({
        where: { setupCompleted: true },
        select: { satsrailApiKeyEncrypted: true, satsrailApiUrl: true },
      });

      if (settings?.satsrailApiKeyEncrypted) {
        const sk = decryptSecretKey(settings.satsrailApiKeyEncrypted);
        const order = await satsrail.getOrder(sk, order_id);
        if (!order || order.status !== "paid") {
          return NextResponse.json(
            { error: "Order not verified" },
            { status: 403 }
          );
        }
      }
    } catch {
      return NextResponse.json(
        { error: "Failed to verify order" },
        { status: 502 }
      );
    }
  }

  try {
    await prisma.purchase.create({
      data: {
        customerId: session.id,
        satsrailOrderId: order_id,
        satsrailProductId: product_id,
      },
    });
  } catch (err) {
    // Race-condition guard: a concurrent POST may have inserted the same
    // purchase between the existence check and the insert. If a unique
    // constraint exists in the future this returns 409 cleanly.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json({ error: "Already purchased" }, { status: 409 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
