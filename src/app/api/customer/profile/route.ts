import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCustomerApi } from "@/lib/auth-helpers";
import { validateBody, isValidationError, schemas } from "@/lib/validate";

// Field set returned to the client. Excludes passwordHash and the raw
// profileImageBytes blob (clients fetch the image via /api/images/customer).
const PUBLIC_CUSTOMER_SELECT = {
  id: true,
  nickname: true,
  profileImageMimeType: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET() {
  const result = await requireCustomerApi();
  if (result instanceof NextResponse) return result;

  const customer = await prisma.customer.findUnique({
    where: { id: result.id },
    select: PUBLIC_CUSTOMER_SELECT,
  });

  if (!customer) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ data: customer });
}

export async function PATCH(req: NextRequest) {
  const session = await requireCustomerApi();
  if (session instanceof NextResponse) return session;

  const body = await validateBody(req, schemas.customerProfile);
  if (isValidationError(body)) return body;

  // The legacy `profile_image_id` GridFS pointer doesn't have a direct
  // equivalent on the Prisma schema (profile images are now stored as
  // profileImageBytes via the upload endpoint). Updating from this route
  // is a no-op for now, but we still return the current row so callers
  // get a fresh view.
  void body;

  const customer = await prisma.customer.findUnique({
    where: { id: session.id },
    select: PUBLIC_CUSTOMER_SELECT,
  });

  if (!customer) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ data: customer });
}
