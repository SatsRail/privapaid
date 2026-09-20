import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { storeVideo, videoManifest, videoStream } from "@/lib/protected-video-store";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "privapaid-probe-"));
  vi.stubEnv("PRIVATE_VIDEO_DIR", path.join(root, "private"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
function fixture(codec: string) {
  const file = path.join(root, "sample.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=12", "-t", "0.5", "-c:v", codec, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", file]);
  return readFile(file);
}
function body(data: Buffer) { return new Blob([new Uint8Array(data)]).stream(); }
describe("real video validation", () => {
  it("accepts real H.264, round-trips encrypted storage, and supports decoding", async () => {
    const original = await fixture("libx264");
    const id = await storeVideo(body(original));
    const manifest = await videoManifest(id);
    const result = Buffer.from(await new Response(videoStream(id, manifest, 0, manifest.size - 1, Date.now() + 5000, new AbortController().signal)).arrayBuffer());
    expect(result).toEqual(original);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "null", "-"], { input: result });
  });
  it("rejects unsupported codecs and removes unpublished files", async () => {
    await expect(storeVideo(body(await fixture("mpeg4")))).rejects.toThrow("invalid_video");
    expect(await readdir(path.join(root, "private"))).toEqual([]);
  });
  it("rejects a forged ftyp header even though the first upload sniff passes", async () => {
    const fake = Buffer.alloc(128); fake.write("ftypisom", 4);
    await expect(storeVideo(body(fake))).rejects.toThrow("invalid_video");
    expect(await readdir(path.join(root, "private"))).toEqual([]);
  });
  it("fails closed if FFprobe is unavailable", async () => {
    vi.stubEnv("FFPROBE_PATH", path.join(root, "missing-ffprobe"));
    await expect(storeVideo(body(await fixture("libx264")))).rejects.toThrow("validator_unavailable");
    expect(await readdir(path.join(root, "private"))).toEqual([]);
  });
});
