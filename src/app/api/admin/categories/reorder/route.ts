import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { validateBody, isValidationError, schemas } from "@/lib/validate";

export async function PATCH(req: NextRequest) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;

  const result = await validateBody(req, schemas.reorder);
  if (isValidationError(result)) return result;

  await prisma.$transaction(
    result.items.map((item: { id: string; position: number }) =>
      prisma.category.update({
        where: { id: item.id },
        data: { position: item.position },
      })
    )
  );

  return NextResponse.json({ success: true });
}
