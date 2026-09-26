import { prisma } from "@/lib/prisma";
import { ownerVideoApi, smallJson } from "@/lib/video/api";
import { startUpload, uploadView } from "@/lib/video/uploads";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return ownerVideoApi(request, true, async ownerId => uploadView(await startUpload(ownerId, await smallJson(request))));
}
export async function GET(request: Request) {
  return ownerVideoApi(request, false, async ownerId => {
    const mediaId = new URL(request.url).searchParams.get("mediaId");
    if (!mediaId || mediaId.length > 128) return { items: [] };
    const sessions = await prisma.videoUploadSession.findMany({ where: { ownerId, version: { formatVersion: 1, asset: { mediaId } } },
      take: 10, orderBy: { createdAt: "desc" }, include: { version: { include: { asset: true, job: true } } } });
    return { items: sessions.map(uploadView) };
  });
}
