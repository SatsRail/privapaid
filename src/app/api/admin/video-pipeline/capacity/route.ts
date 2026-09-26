import { ownerVideoApi } from "@/lib/video/api";
import { videoCapacity } from "@/lib/video/capacity";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return ownerVideoApi(request, false, videoCapacity); }
