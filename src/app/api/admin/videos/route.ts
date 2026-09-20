import { NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { MAX_VIDEO_BYTES, storeVideo } from "@/lib/protected-video-store";
import { VIDEO_REFERENCE_PREFIX } from "@/lib/protected-video-reference";
import { VideoError, videoDiagnostic } from "@/lib/protected-video-errors";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const auth = await requireOwnerApi();
  if (auth instanceof NextResponse) return auth;
  // Prefer the canonical public origin when a TLS proxy uses an internal URL.
  const publicOrigin = new URL(process.env.AUTH_URL || process.env.NEXTAUTH_URL || req.url).origin;
  if (req.headers.get("origin") !== publicOrigin) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const limited = await rateLimit("protected_video_upload", 10);
  if (limited) return limited;
  if (!process.env.PRIVATE_VIDEO_DIR) return NextResponse.json({ error: "Configure private video storage before uploading." }, { status: 503 });
  if (!req.body || req.headers.get("content-type") !== "video/mp4") return NextResponse.json({ error: "Choose an MP4 video." }, { status: 422 });
  if (Number(req.headers.get("content-length")) > MAX_VIDEO_BYTES) return NextResponse.json({ error: "Maximum video size is 512 MB." }, { status: 413 });
  try {
    const id = await storeVideo(req.body);
    return NextResponse.json({ source_url: `${VIDEO_REFERENCE_PREFIX}${id}.mp4` }, { status: 201 });
  } catch (error) {
    videoDiagnostic(error instanceof VideoError ? error.code : "upload_failed");
    const failures = {
      invalid_video: [422, "Use an MP4 with one H.264 video track and optional AAC audio."],
      validator_unavailable: [503, "Video validation is unavailable. Ask the operator to install FFprobe."],
      validation_timeout: [503, "Video validation timed out. Try a smaller video."],
      storage_full: [507, "Private storage is nearly full. Free space before uploading."],
      upload_busy: [429, "Other uploads are in progress. Please retry shortly."],
      upload_too_large: [413, "Maximum video size is 512 MB."],
    } as const;
    const [status, message] = error instanceof VideoError ? failures[error.code] : [503, "Private video storage is unavailable. Please retry later."];
    return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
