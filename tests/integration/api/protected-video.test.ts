import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setupTestDB, clearCollections, teardownTestDB } from "../../helpers/postgres";
import { createChannel, createMedia, createMediaProduct } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";
import { storeVideo } from "@/lib/protected-video-store";
import { COOKIE_NAME, serializeMacaroonCookie } from "@/lib/macaroon-cookie";
const state = vi.hoisted(() => ({ cookie: "", fetch: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "satsrail_macaroons" && state.cookie ? { value: state.cookie } : undefined }) }));
vi.mock("@/config/instance", () => ({ getInstanceConfig: async () => ({ satsrail: { apiUrl: "https://portal.test/api/v1" } }) }));
vi.mock("@/lib/merchant-key", () => ({ getMerchantKey: async () => "sk_test_local" }));
import { GET } from "@/app/api/media/[id]/video/route";
let root: string, asset: string, original: Buffer;
let mediaId: string, channelId: string;
const productId = "product-protected";
function request() { return new Request("https://shop.test/api/media/test/video", { headers: { Range: "bytes=0-99" } }); }
function params() { return { params: Promise.resolve({ id: mediaId }) }; }
function token(exp: number) {
  return Buffer.from(JSON.stringify({ _rails: { exp: new Date(exp).toISOString() } })).toString("base64") + "--testsignature";
}
function cookie(exp = Date.now() + 60_000) {
  return serializeMacaroonCookie({ [productId]: { m: token(exp), t: Date.now() } });
}
beforeAll(async () => {
  await setupTestDB();
  root = await mkdtemp(path.join(tmpdir(), "privapaid-video-db-"));
  vi.stubEnv("PRIVATE_VIDEO_DIR", path.join(root, "private"));
  const file = path.join(root, "sample.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=12", "-t", "0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
  original = await readFile(file);
  asset = await storeVideo(new Blob([new Uint8Array(original)]).stream());
});
beforeEach(async () => {
  await clearCollections();
  const channel = await createChannel(); channelId = channel.id;
  const media = await createMedia(channelId, { sourceUrl: `https://protected-video.invalid/${asset}.mp4` }); mediaId = media.id;
  await createMediaProduct({ mediaId, satsrailProductId: productId, encryptedSource: "wrapped-key", productStatus: "active" });
  state.cookie = cookie();
  state.fetch.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({ valid: true, product_id: productId, key: "product-key", remaining_seconds: 60 }) });
  vi.stubGlobal("fetch", state.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); await teardownTestDB(); });
describe("protected playback with real database and access-gate", () => {
  it("serves a paid byte range and rejects the same URL without a cookie", async () => {
    expect(COOKIE_NAME).toBe("satsrail_macaroons");
    const response = await GET(request(), params());
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(original.subarray(0, 100));
    expect(state.fetch).toHaveBeenCalledWith("https://portal.test/api/v1/m/access/verify", expect.objectContaining({ method: "POST" }));
    state.cookie = "";
    expect((await GET(request(), params())).status).toBe(402);
  });
  it("rejects cross-product proofs and locally expired cookies", async () => {
    state.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ valid: true, product_id: "someone-elses-product", key: "key", remaining_seconds: 60 }) });
    expect((await GET(request(), params())).status).toBe(402);
    state.fetch.mockClear(); state.cookie = cookie(Date.now() - 1000);
    expect((await GET(request(), params())).status).toBe(402);
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it("preserves paid access for an archived product", async () => {
    await prisma.product.update({ where: { satsrailProductId: productId }, data: { productStatus: "archived" } });
    const response = await GET(request(), params());
    expect(response.status).toBe(206); await response.arrayBuffer();
  });
  it("rejects actual deleted media and inactive channels before verification", async () => {
    await prisma.media.update({ where: { id: mediaId }, data: { deletedAt: new Date() } });
    expect((await GET(request(), params())).status).toBe(404);
    await prisma.media.update({ where: { id: mediaId }, data: { deletedAt: null } });
    await prisma.channel.update({ where: { id: channelId }, data: { active: false } });
    expect((await GET(request(), params())).status).toBe(404);
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it("returns a temporary error for an upstream outage without removing the cookie", async () => {
    const before = state.cookie;
    state.fetch.mockRejectedValue(new Error("temporary network failure"));
    expect((await GET(request(), params())).status).toBe(503);
    expect(state.cookie).toBe(before);
  });
});
