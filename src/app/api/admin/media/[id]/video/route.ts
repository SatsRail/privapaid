import { NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { protectedVideoResponse } from "@/lib/protected-video-response";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOwnerApi();
  if (auth instanceof NextResponse) return auth;
  return protectedVideoResponse(req, (await params).id, true);
}
export const HEAD = GET;
