import { ownerVideoApi } from "@/lib/video/api";
import { ownedUpload, abortUpload, uploadView } from "@/lib/video/uploads";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return ownerVideoApi(request, false, async ownerId => uploadView(await ownedUpload((await context.params).id, ownerId)));
}
export async function DELETE(request: Request, context: Context) {
  return ownerVideoApi(request, true, async ownerId => uploadView(await abortUpload((await context.params).id, ownerId)));
}
