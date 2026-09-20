import { prisma } from "@/lib/prisma";
import { getProductsForMedia, verifyMacaroonAccess } from "@/lib/access-gate";
import { decryptEnvelopePayload } from "@/lib/media-envelope";
import { protectedVideoId } from "@/lib/protected-video-reference";
import { videoManifest, videoRange, videoStream } from "@/lib/protected-video-store";

import { acquirePlayback } from "@/lib/protected-video-limits";
import { videoDiagnostic } from "@/lib/protected-video-errors";

const privateHeaders = { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };
export async function protectedVideoResponse(req: Request, id: string, ownerPreview = false): Promise<Response> {
  const error = (status: number) => new Response(null, { status, headers: privateHeaders });
  const release = acquirePlayback();
  if (!release) return new Response(null, { status: 429, headers: { ...privateHeaders, "Retry-After": "3" } });
  let streaming = false;
  try {
    const media = await prisma.media.findFirst({
      where: { id, deletedAt: null, mediaType: "video", status: "ok", channel: { deletedAt: null, active: true } },
      include: { envelope: true },
    });
    if (!media?.envelope) return error(404);
    // Capture the time BEFORE verification so network time cannot extend access.
    const checkedAt = Date.now();
    let expiresAt = checkedAt + 60 * 60 * 1000;
    if (!ownerPreview) {
      const products = await getProductsForMedia(media.id, media.channelId, { includeArchived: true });
      const access = await verifyMacaroonAccess(products.map(p => p.productId));
      if (access.reason === "unavailable") {
        videoDiagnostic("verification_unavailable");
        return error(503);
      }
      if (!access.granted || !access.remainingSeconds || !Number.isFinite(access.remainingSeconds) || access.remainingSeconds <= 0) return error(402);
      expiresAt = checkedAt + Math.min(access.remainingSeconds, 2_147_000) * 1000;
    }
    // Explicit protected-playback exception: resolve the opaque reference only
    // AFTER authorization. No arbitrary URL is fetched, redirected, or returned.
    const assetId = protectedVideoId(decryptEnvelopePayload(media.envelope).toString("utf8"));
    if (!assetId) return error(404);
    const manifest = await videoManifest(assetId);
    const range = videoRange(req.headers.get("range"), manifest.size);
    if (!range) return new Response(null, { status: 416, headers: { ...privateHeaders, "Content-Range": `bytes */${manifest.size}` } });
    if (Date.now() >= expiresAt) return error(402);
    const partial = req.headers.has("range");
    const headers: Record<string, string> = {
      ...privateHeaders,
      "Content-Type": "video/mp4",
      "Content-Length": String(range.end - range.start + 1),
      "Accept-Ranges": "bytes",
      "Content-Disposition": "inline",
      "X-Accel-Buffering": "no",
    };
    if (partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${manifest.size}`;
    if (req.method === "HEAD") return new Response(null, { status: partial ? 206 : 200, headers });
    const body = videoStream(assetId, manifest, range.start, range.end, expiresAt, req.signal, release);
    const response = new Response(body, { status: partial ? 206 : 200, headers });
    streaming = true;
    return response;
  } catch {
    videoDiagnostic("playback_failed");
    return error(503);
  } finally {
    if (!streaming) release();
  }
}
