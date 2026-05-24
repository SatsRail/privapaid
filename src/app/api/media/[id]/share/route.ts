import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import Media from "@/models/Media";
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

  await connectDB();

  const updated = await Media.findByIdAndUpdate(
    id,
    { $inc: { shares_count: 1 } },
    { new: true }
  );

  if (!updated) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }

  return NextResponse.json({ shares_count: updated.shares_count ?? 0 });
}
