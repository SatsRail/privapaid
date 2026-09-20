export class VideoError extends Error {
  constructor(public code: "invalid_video" | "validator_unavailable" | "validation_timeout" | "storage_full" | "upload_busy" | "upload_too_large") {
    super(code);
  }
}

// Never include exception messages, source references, filesystem paths, tokens,
// or keys. These stable codes are suitable for operator log-based alerts.
export function videoDiagnostic(code: VideoError["code"] | "upload_failed" | "stream_failed" | "playback_failed" | "verification_unavailable") {
  console.warn(JSON.stringify({ event: "protected_video", code }));
}
