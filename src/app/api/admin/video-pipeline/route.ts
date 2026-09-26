import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { videoReadiness } from "@/lib/video/readiness";
import { videoConfig, storageIdentity, videoEnabled, VideoSetupError } from "@/lib/video/config";
import { enqueueProbe } from "@/lib/video/jobs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const owner = await requireOwnerApi();
  if (owner instanceof NextResponse) return owner;
  return NextResponse.json(await videoReadiness(), { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: NextRequest) {
  const owner = await requireOwnerApi();
  if (owner instanceof NextResponse) return owner;
  if (!videoEnabled()) return NextResponse.json({ error: "VIDEO_DISABLED" }, { status: 404 });
  // No body: the only operation is an encrypted storage self-test. Require an
  // explicit same-origin header, including for cookie-authenticated API clients.
  const publicOrigin = new URL(process.env.AUTH_URL || process.env.NEXTAUTH_URL || request.url).origin;
  if (request.headers.get("origin") !== publicOrigin) return NextResponse.json({ error: "ORIGIN_REQUIRED" }, { status: 403 });
  try {
    const config = videoConfig();
    // Coalesce clicks across web replicas: at most one probe per store/minute.
    const job = await enqueueProbe(`probe:${storageIdentity(config)}:${Math.floor(Date.now() / 60000)}`);
    return NextResponse.json({ id: job.id, status: job.status }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof VideoSetupError ? err.code : "VIDEO_SETUP_UNAVAILABLE" }, { status: 503 });
  }
}
