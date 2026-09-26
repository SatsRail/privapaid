import { deliveryConfig } from "@/lib/video/delivery-config";
import { checkGrant, PlaybackError } from "@/lib/video/delivery-grant";
import { playbackFailure, playbackJson, privateHeaders } from "@/lib/video/playback-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function cors(origin: string) {
  return { ...privateHeaders, "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
}
export async function OPTIONS(request: Request) {
  try {
    const config = deliveryConfig();
    if (request.headers.get("Origin") !== config.appOrigin) throw new PlaybackError("ORIGIN_DENIED", 403);
    return new Response(null, { status: 204, headers: cors(config.appOrigin) });
  } catch (error) { return playbackFailure(error); }
}
export async function POST(request: Request) {
  try {
    const config = deliveryConfig();
    if (request.headers.get("Origin") !== config.appOrigin) throw new PlaybackError("ORIGIN_DENIED", 403);
    const { grant, path, expiresAt } = checkGrant(config, await playbackJson(request));
    const headers = new Headers(cors(config.appOrigin));
    for (const [name, value] of Object.entries(grant)) {
      // Host-only, attempt-scoped, httpOnly. The same names in another movie's
      // path coexist. Never set Domain: it would share the storefront macaroon.
      headers.append("Set-Cookie", `${name}=${value}; Path=${path}; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}; HttpOnly; SameSite=Lax${config.secure ? "; Secure" : ""}`);
    }
    return new Response(null, { status: 204, headers });
  } catch (error) { return playbackFailure(error); }
}
