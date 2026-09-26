import { ownerVideoApi, requestStream } from "@/lib/video/api";
import { receivePart, uploadView } from "@/lib/video/uploads";
import { videoConfig } from "@/lib/video/config";
import { videoStorage } from "@/lib/video/storage";
import { IngestionError } from "@/lib/video/ingestion-errors";
import { PART_BYTES } from "@/lib/video/ingestion-config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 150;
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return ownerVideoApi(request, true, async ownerId => {
    if (request.headers.get("content-type") !== "application/octet-stream" || Number(request.headers.get("content-length")) > PART_BYTES || !/^\d+$/.test(request.headers.get("upload-offset") || "")) throw new IngestionError("INVALID_UPLOAD", 413);
    const config = videoConfig(), signal = AbortSignal.any([request.signal, AbortSignal.timeout(110000)]);
    const stream = requestStream(request), abort = () => stream.destroy(new Error("Upload interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      return uploadView(await receivePart((await context.params).id, ownerId, Number(request.headers.get("upload-offset")),
        request.headers.get("x-content-sha256") || "", stream, videoStorage(config), config, signal));
    } finally { signal.removeEventListener("abort", abort); stream.destroy(); }
  });
}
