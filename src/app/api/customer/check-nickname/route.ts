import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const nickname = req.nextUrl.searchParams.get("nickname");

  if (!nickname || nickname.length < 2) {
    return NextResponse.json({ available: false });
  }

  // Customer.nickname is a citext column with a unique index — the
  // case-insensitive match happens at the DB level (no app-side collation).
  const existing = await prisma.customer.findUnique({
    where: { nickname },
    select: { id: true },
  });

  return NextResponse.json({ available: !existing });
}
