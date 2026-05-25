import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCustomerApi } from "@/lib/auth-helpers";
import { validateBody, isValidationError, schemas } from "@/lib/validate";

export async function GET() {
  const session = await requireCustomerApi();
  if (session instanceof NextResponse) return session;

  // favorite_channel_ids[] is now an M2M relation. Reconstruct the legacy
  // shape (array of channel ids) so the client UI doesn't have to change.
  const customer = await prisma.customer.findUnique({
    where: { id: session.id },
    select: { favoriteChannels: { select: { id: true } } },
  });

  const favorite_channel_ids =
    customer?.favoriteChannels.map((c) => c.id) ?? [];

  return NextResponse.json({ favorite_channel_ids });
}

export async function POST(req: NextRequest) {
  const session = await requireCustomerApi();
  if (session instanceof NextResponse) return session;

  const result = await validateBody(req, schemas.favorite);
  if (isValidationError(result)) return result;
  const { channel_id } = result;

  await prisma.customer.update({
    where: { id: session.id },
    data: { favoriteChannels: { connect: { id: channel_id } } },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await requireCustomerApi();
  if (session instanceof NextResponse) return session;

  const result = await validateBody(req, schemas.favorite);
  if (isValidationError(result)) return result;
  const { channel_id } = result;

  await prisma.customer.update({
    where: { id: session.id },
    data: { favoriteChannels: { disconnect: { id: channel_id } } },
  });

  return NextResponse.json({ ok: true });
}
