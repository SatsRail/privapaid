import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCustomerApi } from "@/lib/auth-helpers";
import { validateBody, isValidationError, schemas } from "@/lib/validate";

// Field set returned to the client. Excludes passwordHash and the raw
// profileImageBytes blob (clients fetch the image via /api/images/customer).
const PUBLIC_CUSTOMER_SELECT = {
  id: true,
  nickname: true,
  profileImageId: true,
  profileImageMimeType: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function serializeCustomer(c: {
  id: string;
  nickname: string;
  profileImageId: string | null;
  profileImageMimeType: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    _id: c.id,
    nickname: c.nickname,
    profile_image_id: c.profileImageId ?? "",
    profile_image_mime_type: c.profileImageMimeType ?? null,
    deleted_at: c.deletedAt,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

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

  return NextResponse.json({ data: serializeCustomer(customer) });
}

export async function PATCH(req: NextRequest) {
  const session = await requireCustomerApi();
  if (session instanceof NextResponse) return session;

  const body = await validateBody(req, schemas.customerProfile);
  if (isValidationError(body)) return body;

  // Only profileImageId is editable from this route — the bytes/mime
  // columns are owned by the upload endpoint.
  const data: { profileImageId?: string } = {};
  if (typeof body.profile_image_id === "string") {
    data.profileImageId = body.profile_image_id;
  }

  if (Object.keys(data).length === 0) {
    const current = await prisma.customer.findUnique({
      where: { id: session.id },
      select: PUBLIC_CUSTOMER_SELECT,
    });
    if (!current) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ data: serializeCustomer(current) });
  }

  try {
    const customer = await prisma.customer.update({
      where: { id: session.id },
      data,
      select: PUBLIC_CUSTOMER_SELECT,
    });
    return NextResponse.json({ data: serializeCustomer(customer) });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
