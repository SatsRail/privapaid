// Bounds work in each app process. Replicas need proxy-level aggregate limits.
// Admission includes verification and disk I/O, not just the response body.
let active = 0;
export function acquirePlayback(): (() => void) | null {
  const configured = Number(process.env.PRIVATE_VIDEO_MAX_STREAMS ?? "16");
  const limit = Number.isSafeInteger(configured) && configured >= 1 && configured <= 128 ? configured : 16;
  if (active >= limit) return null;
  active++;
  let released = false;
  return () => { if (!released) { released = true; active--; } };
}
