import { ownerVideoApi } from "@/lib/video/api";
import { resumeUpload, uploadView } from "@/lib/video/uploads";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return ownerVideoApi(request, true, async ownerId => uploadView(await resumeUpload((await context.params).id, ownerId)));
}
