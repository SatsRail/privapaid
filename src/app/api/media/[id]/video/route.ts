import { protectedVideoResponse } from "@/lib/protected-video-response";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return protectedVideoResponse(req, (await params).id);
}
export const HEAD = GET;
