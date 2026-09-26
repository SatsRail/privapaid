import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { wrapDek } from "@/lib/content-dek";
import { COOKIE_NAME } from "@/lib/macaroon-cookie";
import { verifySatsrailToken } from "@/lib/access-gate";
import { videoConfig, storageIdentity } from "@/lib/video/config";
import { LocalVideoStorage } from "@/lib/video/storage/local";
import { startPlaybackSession } from "@/lib/video/playback-session";
import { checkGrant } from "@/lib/video/delivery-grant";
import { deliveryConfig } from "@/lib/video/delivery-config";
import { POST } from "@/app/api/media/[id]/playback-session/route";
import { GET } from "@/app/api/video-delivery/objects/[...key]/route";
import { encryptedMovie, playbackEnv } from "../../helpers/video-playback";
import { createChannel, createMedia } from "../../helpers/factories";
import { clearCollections } from "../../helpers/postgres";
const fixture = vi.hoisted(() => ({ cookie: "", remote: {} as Record<string, unknown>, requests: [] as { url: string; body: string }[], status: 200 }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === COOKIE_NAME && fixture.cookie ? { value: fixture.cookie } : undefined }) }));
vi.mock("@/config/instance", () => ({ getInstanceConfig: async () => ({ satsrail: { apiUrl: "https://satsrail.test/api/v1" } }) }));
vi.mock("@/lib/merchant-key", () => ({ getMerchantKey: async () => "sk_live_fixture" }));
let root: string, mediaId: string, movie: Awaited<ReturnType<typeof encryptedMovie>>;
beforeAll(async () => {
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
  root = await mkdtemp(path.join(tmpdir(), "ppv-session-"));
});
beforeEach(async () => {
  await clearCollections(); fixture.status = 200; fixture.requests = [];
  for (const [k, v] of Object.entries(playbackEnv(root))) vi.stubEnv(k, v);
  const storage = new LocalVideoStorage(root); await storage.check();
  movie = await encryptedMovie(storage, { "play.mpd": Buffer.from("manifest"), "init-0.mp4": Buffer.from("fixture encrypted movie") });
  const media = await createMedia((await createChannel()).id); mediaId = media.id;
  const s = movie.session;
  const product = await prisma.product.create({ data: { satsrailProductId: s.product_id, mediaId, productStatus: "active", keyFingerprint: s.key_fingerprint } });
  await prisma.mediaProduct.create({ data: { mediaId, productId: product.id, encryptedDek: s.encrypted_blob, keyFingerprint: s.key_fingerprint } });
  await prisma.videoAsset.create({ data: { id: s.asset, mediaId, generation: 1 } });
  await prisma.videoAssetVersion.create({ data: { id: s.version, assetId: s.asset, generation: 1, status: "ready", provider: "local",
    storagePrefix: `assets/${s.asset}/versions/${s.version}`, wrappedRootKey: wrapDek(movie.root), formatVersion: 1,
    encodingProfile: "h264-720p-v1", segmentSeconds: 4, manifestKey: `${s.prefix}/play.mpd`, manifestSha256: movie.descriptor.manifest.sha256,
    encryptedDescriptor: new Uint8Array(movie.encryptedDescriptor), objectCount: 3, encryptedBytes: 300, durationMs: 1000, progress: 100, readyAt: new Date(), storageIdentity: storageIdentity(videoConfig()) } });
  await prisma.videoAsset.update({ where: { id: s.asset }, data: { publishedVersionId: s.version } });
  fixture.cookie = JSON.stringify({ [s.product_id]: { m: "fixture-token", t: Date.now() } });
  fixture.remote = { valid: true, product_id: s.product_id, key: s.key, key_fingerprint: s.key_fingerprint,
    remaining_seconds: 10, server_time: 1000, expires_at: 1010 };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    fixture.requests.push({ url, body: String(init.body) });
    return Response.json(fixture.remote, { status: fixture.status, headers: fixture.status === 429 ? { "Retry-After": "45" } : {} });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); await prisma.$disconnect(); });
function request() { return new Request("https://app.video.test/api/session", { method: "POST", headers: { Origin: "https://app.video.test" }, body: "{}" }); }
describe("paid video session and delivery boundaries", () => {
  it("bounds grants by authoritative entitlement, reuses only covering products, and sends only the token to SatsRail", async () => {
    const started = Date.now(); const response = await POST(request(), { params: Promise.resolve({ id: mediaId }) });
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toContain("no-store");
    const session = await response.json();
    expect(session.expiresAt).toBeLessThanOrEqual(started + 8000);
    expect(checkGrant(deliveryConfig(), session.grant).prefix).toBe(movie.session.prefix);
    expect(fixture.requests).toEqual([{ url: "https://satsrail.test/api/v1/m/access/verify", body: JSON.stringify({ access_token: "fixture-token" }) }]);
    expect(JSON.stringify(session)).not.toContain("sk_live_fixture"); expect(JSON.stringify(session)).not.toContain(movie.root.toString("base64url"));
  });
  it("fails closed for old or inconsistent expiry contracts, yet preserves legacy verification", async () => {
    delete fixture.remote.server_time; delete fixture.remote.expires_at;
    expect((await verifySatsrailToken("fixture-token", movie.session.product_id)).status).toBe("valid");
    await expect(startPlaybackSession(mediaId)).rejects.toMatchObject({ code: "ACCESS_BOUNDS_REQUIRED" });
    fixture.remote.server_time = 1000; fixture.remote.expires_at = 1001;
    await expect(startPlaybackSession(mediaId)).rejects.toMatchObject({ code: "ACCESS_UNAVAILABLE" });
  });
  it("rejects no payment, wrong product, deleted media, disabled channels, and deleted versions", async () => {
    fixture.cookie = ""; await expect(startPlaybackSession(mediaId)).rejects.toMatchObject({ status: 401 });
    fixture.cookie = JSON.stringify({ [movie.session.product_id]: { m: "fixture-token", t: Date.now() } });
    fixture.remote.product_id = randomUUID(); await expect(startPlaybackSession(mediaId)).rejects.toMatchObject({ status: 401 });
    fixture.remote.product_id = movie.session.product_id;
    await prisma.media.update({ where: { id: mediaId }, data: { deletedAt: new Date() } });
    await expect(startPlaybackSession(mediaId)).rejects.toMatchObject({ status: 404 });
    await prisma.media.update({ where: { id: mediaId }, data: { deletedAt: null } });
    await prisma.channel.updateMany({ data: { active: false } }); await expect(startPlaybackSession(mediaId)).rejects.toMatchObject({ status: 404 });
    await prisma.channel.updateMany({ data: { active: true } });
    await prisma.videoAssetVersion.update({ where: { id: movie.session.version }, data: { deletedAt: new Date() } });
    await expect(startPlaybackSession(mediaId)).rejects.toMatchObject({ status: 404 });
  });
  it("honors throttling and preserves the payment cookie on an upstream outage", async () => {
    fixture.status = 429; const originalCookie = fixture.cookie;
    const response = await POST(request(), { params: Promise.resolve({ id: mediaId }) });
    expect(response.status).toBe(503); expect(response.headers.get("Retry-After")).toBe("45"); expect(fixture.cookie).toBe(originalCookie);
  });
  it("rechecks local availability after remote verification completes", async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => {
      await prisma.media.update({ where: { id: mediaId }, data: { status: "error" } });
      return Response.json(fixture.remote);
    });
    await expect(startPlaybackSession(mediaId)).rejects.toMatchObject({ status: 404 });
  });
  it("checks delivery before reading cached ciphertext; rejects a different movie, source paths and expired grants", async () => {
    const s = await startPlaybackSession(mediaId), config = deliveryConfig();
    const cookie = Object.entries(s.grant).map(([k, v]) => `${k}=${v}`).join("; ");
    async function read(key: string, cookieHeader = cookie) {
      return GET(new Request(`${config.objectBase}${key}`, { headers: { Origin: config.appOrigin, Cookie: cookieHeader } }), { params: Promise.resolve({ key: key.split("/") }) });
    }
    const key = `${s.prefix}/init-0.mp4`;
    for (let i = 0; i < 2; i++) { const res = await read(key); expect(res.status).toBe(200); expect(Buffer.from(await res.arrayBuffer())).toEqual(movie.encrypted["init-0.mp4"]); }
    expect((await read(key, "")).status).toBe(403);
    expect((await read(key.replace(s.asset, randomUUID()))).status).toBe(403);
    expect((await read(`${s.prefix}/source-000000.bin`)).status).toBe(403);
    vi.spyOn(Date, "now").mockReturnValue(s.expiresAt);
    try { expect((await read(key)).status).toBe(403); } finally { vi.restoreAllMocks(); }
    expect(fixture.requests).toHaveLength(1);
  });
});
