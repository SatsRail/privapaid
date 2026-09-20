import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { createEnvelopeArtifacts } from "@/lib/media-envelope";
import { storeVideo, videoManifest, videoRange, videoStream, VIDEO_CHUNK_SIZE } from "@/lib/protected-video-store";
import { VIDEO_REFERENCE_PREFIX, protectedVideoId } from "@/lib/protected-video-reference";

const mocks = vi.hoisted(() => ({ media: vi.fn(), products: vi.fn(), access: vi.fn(), owner: vi.fn(), rate: vi.fn(), validate: vi.fn() }));
vi.mock("@/lib/protected-video-probe", () => ({ validateVideo: mocks.validate }));
vi.mock("@/lib/prisma", () => ({ prisma: { media: { findFirst: mocks.media } } }));
vi.mock("@/lib/access-gate", () => ({ getProductsForMedia: mocks.products, verifyMacaroonAccess: mocks.access }));
vi.mock("@/lib/auth-helpers", () => ({ requireOwnerApi: mocks.owner }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rate }));
import { GET, HEAD } from "@/app/api/media/[id]/video/route";
import { GET as preview } from "@/app/api/admin/media/[id]/video/route";
import { POST } from "@/app/api/admin/videos/route";

let root: string;
let previous: string | undefined;
const params = { params: Promise.resolve({ id: "media-1" }) };
function request(range?: string, method = "GET") {
  return new Request("https://demo.test/api/media/media-1/video", { method, headers: range ? { Range: range } : {} });
}
function mp4(size = VIDEO_CHUNK_SIZE + 83) {
  const data = Buffer.alloc(size, 37);
  data.writeUInt32BE(24, 0); data.write("ftypisom", 4);
  return data;
}
function body(data: Buffer) { return new Blob([new Uint8Array(data)]).stream(); }
async function seed() {
  const data = mp4();
  const id = await storeVideo(body(data));
  const envelope = createEnvelopeArtifacts(Buffer.from(`${VIDEO_REFERENCE_PREFIX}${id}.mp4`));
  mocks.media.mockResolvedValue({ id: "media-1", channelId: "channel-1", envelope });
  return { data, id };
}
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.validate.mockImplementation(async (body: ReadableStream) => { await body.cancel(); });
  vi.stubEnv("NEXTAUTH_URL", "https://demo.test");
  vi.stubEnv("AUTH_URL", "");
  root = await mkdtemp(path.join(tmpdir(), "privapaid-video-test-"));
  previous = process.env.PRIVATE_VIDEO_DIR; process.env.PRIVATE_VIDEO_DIR = root;
  mocks.products.mockResolvedValue([{ productId: "paid-product" }]);
  mocks.access.mockResolvedValue({ granted: true, remainingSeconds: 600 });
  mocks.owner.mockResolvedValue({ role: "owner" });
  mocks.rate.mockResolvedValue(null);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (previous === undefined) delete process.env.PRIVATE_VIDEO_DIR; else process.env.PRIVATE_VIDEO_DIR = previous;
  await rm(root, { recursive: true, force: true });
});

describe("protected playback", () => {
  it("stores ciphertext and round-trips bytes across encrypted chunk boundaries", async () => {
    const { data, id } = await seed();
    const encrypted = await readFile(path.join(root, id, "0.bin"));
    expect(encrypted.includes(Buffer.from("ftypisom"))).toBe(false);
    const response = await GET(request(`bytes=${VIDEO_CHUNK_SIZE - 7}-${VIDEO_CHUNK_SIZE + 20}`), params);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${VIDEO_CHUNK_SIZE - 7}-${VIDEO_CHUNK_SIZE + 20}/${data.length}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data.subarray(VIDEO_CHUNK_SIZE - 7, VIDEO_CHUNK_SIZE + 21));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.access).toHaveBeenCalledWith(["paid-product"]);
    expect(mocks.products).toHaveBeenCalledWith("media-1", "channel-1", { includeArchived: true });
  });
  it("rejects copied links without access, even when the asset reference is known", async () => {
    await seed(); mocks.access.mockResolvedValue({ granted: false });
    const response = await GET(request(), params);
    expect(response.status).toBe(402);
    expect(await response.text()).toBe("");
  });
  it("rejects expired access and does not permit an admin-preview query bypass", async () => {
    await seed(); mocks.access.mockResolvedValue({ granted: true, remainingSeconds: 0 });
    expect((await GET(new Request("https://demo.test/api/media/media-1/video?preview=true"), params)).status).toBe(402);
  });
  it("serves full and suffix requests and HEAD without releasing a body", async () => {
    const { data } = await seed();
    const full = await GET(request(), params);
    expect(full.status).toBe(200); expect(Buffer.from(await full.arrayBuffer())).toEqual(data);
    const suffix = await GET(request("bytes=-5"), params);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(data.subarray(-5));
    const head = await HEAD(request(undefined, "HEAD"), params);
    expect(head.headers.get("content-length")).toBe(String(data.length));
    expect(await head.text()).toBe("");
  });
  it("rejects invalid ranges without leaking paths", async () => {
    const { data } = await seed();
    for (const range of ["bytes=99999999-", "bytes=4-2", "bytes=0-1,4-5", "bytes=-0"]) {
      const response = await GET(request(range), params);
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${data.length}`);
    }
  });
  it("distinguishes temporary verification failure from missing payment", async () => {
    await seed(); mocks.access.mockResolvedValue({ granted: false, reason: "unavailable" });
    expect((await GET(request(), params)).status).toBe(503);
  });
  it("limits active streams and releases admission when cancelled or finished", async () => {
    await seed(); vi.stubEnv("PRIVATE_VIDEO_MAX_STREAMS", "1");
    const first = await GET(request(), params);
    expect(first.status).toBe(200);
    const busy = await GET(request(), params);
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("3");
    await first.body!.cancel();
    expect((await HEAD(request(undefined, "HEAD"), params)).status).toBe(200);
    const next = await GET(request("bytes=0-11"), params);
    await next.arrayBuffer();
    expect((await HEAD(request(undefined, "HEAD"), params)).status).toBe(200);
  });
  it("never proxies existing external demo sources", async () => {
    mocks.media.mockResolvedValue({ id: "media-1", channelId: "channel-1", envelope: createEnvelopeArtifacts(Buffer.from("https://www.youtube.com/watch?v=demo")) });
    expect((await GET(request(), params)).status).toBe(404);
  });
  it("fails closed for missing media, storage failure, and verification outages", async () => {
    mocks.media.mockResolvedValue(null);
    expect((await GET(request(), params)).status).toBe(404);
    const { id } = await seed();
    await rm(path.join(root, id), { recursive: true });
    const unavailable = await GET(request(), params);
    expect(unavailable.status).toBe(503); expect(await unavailable.text()).toBe("");
    mocks.access.mockRejectedValue(new Error("portal unavailable"));
    expect((await GET(request(), params)).status).toBe(503);
  });
  it("requires owner authorization for the separate preview endpoint", async () => {
    await seed(); mocks.owner.mockResolvedValue(NextResponse.json({}, { status: 403 }));
    expect((await preview(request(), params)).status).toBe(403);
    mocks.owner.mockResolvedValue({ role: "owner" });
    const response = await preview(request("bytes=0-11"), params);
    expect(response.status).toBe(206); await response.arrayBuffer();
    expect(mocks.access).not.toHaveBeenCalled();
  });
  it("authenticates chunk position and detects swapped ciphertext", async () => {
    const { id } = await seed();
    await writeFile(path.join(root, id, "1.bin"), await readFile(path.join(root, id, "0.bin")));
    const response = await GET(request(`bytes=${VIDEO_CHUNK_SIZE}-`), params);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });
  it("stops an in-flight stream at expiry and on cancellation", async () => {
    const { id } = await seed(); const manifest = await videoManifest(id);
    const stream = videoStream(id, manifest, 0, manifest.size - 1, Date.now() + 20, new AbortController().signal);
    const reader = stream.getReader();
    await reader.read();
    await new Promise(resolve => setTimeout(resolve, 40));
    await expect(reader.read()).rejects.toThrow();
    const abort = new AbortController();
    const cancelled = videoStream(id, manifest, 0, manifest.size - 1, Date.now() + 60000, abort.signal);
    abort.abort(); await expect(cancelled.getReader().read()).rejects.toThrow();
  });
  it("releases a playback slot after a minute without reads", async () => {
    const { id } = await seed();
    const manifest = await videoManifest(id);
    const finished = vi.fn();
    vi.useFakeTimers();
    try {
      const stream = videoStream(id, manifest, 0, manifest.size - 1, Date.now() + 120_000, new AbortController().signal, finished);
      const closed = stream.getReader().closed.catch(() => "closed");
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await closed).toBe("closed");
      expect(finished).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("rejects malformed references and traversal", () => {
    expect(protectedVideoId("https://protected-video.invalid/../../secret.mp4")).toBeNull();
    expect(protectedVideoId("https://protected-video.invalid.evil/anything.mp4")).toBeNull();
    expect(videoRange("bytes=9007199254740992-", 100)).toBeNull();
  });
});

describe("protected upload", () => {
  function upload(headers: Record<string, string> = {}) {
    return new Request("https://demo.test/api/admin/videos", { method: "POST", headers: { Origin: "https://demo.test", "Content-Type": "video/mp4", ...headers }, body: new Uint8Array(mp4(128)) });
  }
  it("accepts an owner upload and returns only an opaque marker", async () => {
    const response = await POST(upload());
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(protectedVideoId(result.source_url)).not.toBeNull();
    expect(Object.keys(result)).toEqual(["source_url"]);
  });
  it("accepts the configured public origin behind a TLS proxy", async () => {
    const req = new Request("http://localhost:3000/api/admin/videos", { method: "POST", headers: { Origin: "https://demo.test", "Content-Type": "video/mp4" }, body: new Uint8Array(mp4(128)) });
    expect((await POST(req)).status).toBe(201);
  });
  it("rejects unauthorized, cross-origin and oversized requests", async () => {
    mocks.owner.mockResolvedValue(NextResponse.json({}, { status: 401 }));
    expect((await POST(upload())).status).toBe(401);
    mocks.owner.mockResolvedValue({ role: "owner" });
    expect((await POST(upload({ Origin: "https://evil.test" }))).status).toBe(403);
    expect((await POST(upload({ "Content-Length": String(513 * 1024 * 1024) }))).status).toBe(413);
    expect((await POST(upload({ "Content-Type": "text/html" }))).status).toBe(422);
  });
  it("fails before storing a video when the configured disk reserve cannot be met", async () => {
    vi.stubEnv("PRIVATE_VIDEO_MIN_FREE_MB", "999999999");
    const response = await POST(upload());
    expect(response.status).toBe(507);
    expect((await response.json()).error).toContain("nearly full");
  });
  it("bounds concurrent upload validation and releases slots afterward", async () => {
    const release: (() => void)[] = [];
    mocks.validate.mockImplementation((stream: ReadableStream) => new Promise<void>(resolve => {
      release.push(() => { void stream.cancel().then(resolve); });
    }));
    const first = storeVideo(body(mp4(128)));
    const second = storeVideo(body(mp4(128)));
    await vi.waitFor(() => expect(release).toHaveLength(2));
    try {
      await expect(storeVideo(body(mp4(128)))).rejects.toThrow("upload_busy");
    } finally {
      release.forEach(done => done());
      await Promise.all([first, second]);
    }
    mocks.validate.mockImplementation(async (stream: ReadableStream) => stream.cancel());
    await expect(storeVideo(body(mp4(128)))).resolves.toMatch(/^[a-f0-9-]+$/);
  });
  it("removes staging files after an interrupted upload", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("disconnect")); } });
    await expect(storeVideo(stream)).rejects.toThrow("disconnect");
    expect(await readdir(root)).toEqual([]);
  });
  it("rejects invalid MP4 bytes and unavailable configuration", async () => {
    await expect(storeVideo(body(Buffer.from("not a video file")))).rejects.toThrow("invalid_video");
    delete process.env.PRIVATE_VIDEO_DIR;
    expect((await POST(upload())).status).toBe(503);
  });
});
