import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { videoEnabled } from "@/lib/video/config";
import { listAssets } from "@/lib/video/assets";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const owner = await requireOwnerApi();
  if (owner instanceof NextResponse) return owner;
  if (!videoEnabled()) return NextResponse.json({ error: "VIDEO_DISABLED" }, { status: 404 });
  const limit = Number(request.nextUrl.searchParams.get("limit") || 25);
  const cursor = request.nextUrl.searchParams.get("cursor") || undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(cursor))) return NextResponse.json({ error: "VIDEO_PAGE_INVALID" }, { status: 400 });
  try { return NextResponse.json(await listAssets(limit, cursor), { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ error: "VIDEO_SETUP_UNAVAILABLE" }, { status: 503 }); }
}
