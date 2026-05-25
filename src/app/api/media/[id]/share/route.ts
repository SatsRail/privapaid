import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";

// Fire-and-forget share counter. The actual share (navigator.share /
// clipboard write) happens client-side before this POST is sent; the
// endpoint is best-effort telemetry, IP-rate-limited so a single client
// can't pump the counter.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const limited = await rateLimit("share", 20);
  if (limited) return limited;

  try {
    const updated = await prisma.media.update({
      where: { id },
      data: { sharesCount: { increment: 1 } },
      select: { sharesCount: true },
    });
    return NextResponse.json({ shares_count: updated.sharesCount });
  } catch (err) {
    // P2025 = record not found
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      return NextResponse.json({ error: "Media not found" }, { status: 404 });
    }
    throw err;
  }
}
