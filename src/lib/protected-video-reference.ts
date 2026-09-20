// A reserved, non-routable marker, not an origin or a bearer credential.
export const VIDEO_REFERENCE_PREFIX = "https://protected-video.invalid/";
export function protectedVideoId(source: string): string | null {
  const match = /^https:\/\/protected-video\.invalid\/([a-f0-9-]{36})\.mp4$/.exec(source);
  return match?.[1] ?? null;
}
