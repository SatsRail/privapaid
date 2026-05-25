import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { validateBody, isValidationError, schemas } from "@/lib/validate";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ data: category });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;
  const result = await validateBody(req, schemas.categoryUpdate);
  if (isValidationError(result)) return result;

  const { id } = await params;

  const updates: {
    name?: string;
    slug?: string;
    position?: number;
    active?: boolean;
  } = {};
  if (result.name !== undefined) updates.name = result.name;
  if (result.slug !== undefined) updates.slug = result.slug;
  if (result.position !== undefined) updates.position = result.position;
  if (result.active !== undefined) updates.active = result.active;

  if (updates.slug) {
    const existing = await prisma.category.findFirst({
      where: { slug: updates.slug, NOT: { id } },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: "Slug already taken" },
        { status: 422 }
      );
    }
  }

  let category;
  try {
    category = await prisma.category.update({ where: { id }, data: updates });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  audit({
    actorId: auth.id,
    actorEmail: auth.email,
    actorType: "admin",
    action: "category.update",
    targetType: "category",
    targetId: id,
    details: { fields: Object.keys(updates) },
  });

  return NextResponse.json({ data: category });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  let category;
  try {
    category = await prisma.category.update({
      where: { id },
      data: { active: false },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  audit({
    actorId: auth.id,
    actorEmail: auth.email,
    actorType: "admin",
    action: "category.delete",
    targetType: "category",
    targetId: id,
  });

  return NextResponse.json({ data: category });
}
