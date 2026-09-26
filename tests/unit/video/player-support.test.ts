import { expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ constructed: vi.fn(), supported: vi.fn(() => false) }));
vi.mock("shaka-player", () => ({ default: { polyfill: { installAll() {} }, Player: class {
  constructor() { mock.constructed(); }
  static isBrowserSupported = mock.supported;
} } }));
import { createVideoPlayer } from "@/lib/video/browser-player";
it("reports unsupported playback before constructing a player or requesting a key", async () => {
  const fetch = vi.spyOn(globalThis, "fetch"), changed = vi.fn();
  try {
    const player = createVideoPlayer({} as HTMLVideoElement, "movie", changed);
    await player.ready; await player.handle.destroy();
    expect(changed).toHaveBeenCalledWith("unsupported"); expect(mock.constructed).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
