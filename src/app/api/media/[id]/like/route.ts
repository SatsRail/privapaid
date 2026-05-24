import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import Media from "@/models/Media";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { rateLimit } from "@/lib/rate-limit";

// Like toggle endpoint. ActionRow tracks per-user like state in
// localStorage and sends `{ action: "like" | "unlike" }` whenever the
// user flips it. Server applies the +1 / -1 delta. There's no per-user
// uniqueness check — the IP rate limit is the only abuse control. See
// the plan in /Users/rafael/.claude/plans/purrfect-prancing-waffle.md
// for the trade-off discussion.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const limited = await rateLimit("like", 30);
  if (limited) return limited;

  const validated = await validateBody(req, schemas.likeAction);
  if (isValidationError(validated)) return validated;

  const { action } = validated;

  await connectDB();

  if (action === "like") {
    const updated = await Media.findByIdAndUpdate(
      id,
      { $inc: { likes_count: 1 } },
      { new: true }
    );
    if (!updated) {
      return NextResponse.json({ error: "Media not found" }, { status: 404 });
    }
    return NextResponse.json({ likes_count: updated.likes_count });
  }

  // unlike — conditional decrement so the counter never goes below 0.
  const updated = await Media.findOneAndUpdate(
    { _id: id, likes_count: { $gt: 0 } },
    { $inc: { likes_count: -1 } },
    { new: true }
  );

  if (updated) {
    return NextResponse.json({ likes_count: updated.likes_count });
  }

  // Either the doc doesn't exist or the counter is already at 0.
  // Re-fetch to distinguish — return 404 for the former, current value
  // (0) for the latter.
  const current = await Media.findById(id).select("likes_count").lean();
  if (!current) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }
  return NextResponse.json({ likes_count: current.likes_count });
}
