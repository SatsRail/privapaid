import { NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { videoConfig, videoEnabled, VideoSetupError } from "./config";
import { IngestionError, ingestionMessages } from "./ingestion-errors";
import { objectBytes } from "./streams";
export async function ownerVideoApi(request: Request, mutation: boolean, action: (ownerId: string) => Promise<unknown>) {
  const owner = await requireOwnerApi();
  if (owner instanceof NextResponse) return owner;
  if (!videoEnabled()) return NextResponse.json({ error: "VIDEO_DISABLED" }, { status: 404 });
  try {
    videoConfig();
    if (mutation && request.headers.get("origin") !== new URL(process.env.AUTH_URL || process.env.NEXTAUTH_URL || request.url).origin) return NextResponse.json({ error: "ORIGIN_REQUIRED" }, { status: 403 });
    return NextResponse.json(await action(owner.id), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const code = err instanceof IngestionError || err instanceof VideoSetupError ? err.code : "STORAGE_UNAVAILABLE";
    return NextResponse.json({ error: code, message: code in ingestionMessages ? ingestionMessages[code as keyof typeof ingestionMessages] : "Video setup is incomplete." },
      { status: err instanceof IngestionError ? err.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
export function requestStream(request: Request) {
  if (!request.body) throw new IngestionError("INVALID_UPLOAD", 422);
  return Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>);
}
export async function smallJson(request: Request) {
  if (Number(request.headers.get("content-length")) > 4096) throw new IngestionError("INVALID_UPLOAD", 413);
  const stream = requestStream(request);
  try { return JSON.parse((await objectBytes(stream, 4096, AbortSignal.any([request.signal, AbortSignal.timeout(10000)]))).toString("utf8")); }
  catch (err) { if (err instanceof IngestionError) throw err; throw new IngestionError("INVALID_UPLOAD", 422); }
  finally { stream.destroy(); }
}
