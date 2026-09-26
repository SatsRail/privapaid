import { Readable } from "node:stream";
import { deliveryConfig } from "@/lib/video/delivery-config";
import { checkGrant, PlaybackError } from "@/lib/video/delivery-grant";
import { playbackFailure, privateHeaders } from "@/lib/video/playback-api";
import { MAX_CIPHER_BYTES, OUTPUT_NAME } from "@/lib/video/playback-contract";
import { videoStorage } from "@/lib/video/storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Development adapter only. In production the CDN authenticates viewers and
// reads S3 directly; this endpoint cannot become a production byte proxy.
export async function GET(request: Request, context: { params: Promise<{ key: string[] }> }) {
  try {
    const config = deliveryConfig();
    if (config.provider !== "local" || process.env.NODE_ENV === "production") throw new PlaybackError("NOT_FOUND", 404);
    if (request.headers.get("Origin") !== config.appOrigin || new URL(request.url).search) throw new PlaybackError("DELIVERY_DENIED", 403);
    const cookies = Object.fromEntries((request.headers.get("Cookie") || "").split(/;\s*/).filter(v => v.startsWith("CloudFront-")).map(v => { const i = v.indexOf("="); return [v.slice(0, i), v.slice(i + 1)]; }));
    const { prefix } = checkGrant(config, cookies);
    const key = (await context.params).key.join("/"), name = key.split("/").at(-1)!;
    if (key !== `${prefix}/${name}` || !OUTPUT_NAME.test(name)) throw new PlaybackError("DELIVERY_DENIED", 403);
    const storage = videoStorage(config.storage), info = await storage.head(key);
    if (info.bytes < 33 || info.bytes > MAX_CIPHER_BYTES) throw new PlaybackError("OBJECT_INVALID");
    const stream = await storage.read(key);
    request.signal.addEventListener("abort", () => stream.destroy(), { once: true });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: { ...privateHeaders,
      "Content-Type": "application/octet-stream", "Content-Length": String(info.bytes),
      "Access-Control-Allow-Origin": config.appOrigin, "Access-Control-Allow-Credentials": "true" } });
  } catch (error) {
    const response = playbackFailure(error);
    try {
      const config = deliveryConfig();
      if (request.headers.get("Origin") === config.appOrigin) {
        response.headers.set("Access-Control-Allow-Origin", config.appOrigin);
        response.headers.set("Access-Control-Allow-Credentials", "true");
      }
    } catch { /* Incomplete setup remains fail-closed. */ }
    return response;
  }
}
