import { deliveryConfig } from "@/lib/video/delivery-config";
import { PlaybackError } from "@/lib/video/delivery-grant";
import { playbackFailure, playbackJson, privateHeaders } from "@/lib/video/playback-api";
import { startPlaybackSession } from "@/lib/video/playback-session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const config = deliveryConfig();
    if (request.headers.get("Origin") !== config.appOrigin) throw new PlaybackError("ORIGIN_DENIED", 403);
    const input = await playbackJson(request, 256);
    if (Object.keys(input).some(k => k !== "version") || (input.version !== undefined && typeof input.version !== "string")) throw new PlaybackError("INVALID_SESSION", 400);
    return Response.json(await startPlaybackSession((await context.params).id, input.version), { headers: privateHeaders });
  } catch (error) { return playbackFailure(error); }
}
