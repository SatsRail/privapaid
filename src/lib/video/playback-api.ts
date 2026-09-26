import { VideoSetupError } from "./config";
import { PlaybackError } from "./delivery-grant";
export const privateHeaders = { "Cache-Control": "private, no-store", "Vary": "Origin, Cookie", "Referrer-Policy": "no-referrer" };
export function playbackFailure(error: unknown) {
  const e = error instanceof PlaybackError ? error : new PlaybackError(error instanceof VideoSetupError ? error.code : "VIDEO_UNAVAILABLE");
  return Response.json({ error: e.code }, { status: e.status, headers: { ...privateHeaders, ...(e.status >= 500 ? { "Retry-After": String(e.retryAfter) } : {}) } });
}
export async function playbackJson(request: Request, limit = 4096) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = []; let count = 0;
  const timer = setTimeout(() => { void reader.cancel(); }, 5000);
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      count += value.byteLength; if (count > limit) throw new PlaybackError("INVALID_SESSION", 400);
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new PlaybackError("INVALID_SESSION", 400); }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
