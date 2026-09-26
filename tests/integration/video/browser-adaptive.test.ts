import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:https";
import { Readable } from "node:stream";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";
import { POST as grantPost, OPTIONS } from "@/app/api/video-delivery/grant/route";
import { GET as objectGet } from "@/app/api/video-delivery/objects/[...key]/route";
import { LocalVideoStorage } from "@/lib/video/storage/local";
import { deliveryConfig } from "@/lib/video/delivery-config";
import { issueGrant } from "@/lib/video/delivery-grant";
import { adaptiveFixture } from "../../helpers/adaptive-video";
import { encryptedMovie, playbackEnv } from "../../helpers/video-playback";
// Opt-in real browser proof. The session response models a paid SatsRail
// contract; the companion integration test exercises the real session handler.
// No actual payment, live CloudFront, physical Safari or long-film gate claimed.
describe.skipIf(process.env.VIDEO_ADAPTIVE_TEST !== "true").each([4, 10])("adaptive encrypted playback, %ss segments", (segment) => {
  let bytesPerSecond = 2 * 1024 ** 2;
  const fixtureSeconds = segment === 10 ? 120 : 80;
  let root: string, browser: Browser, server: ReturnType<typeof createServer>, appOrigin: string, mediaOrigin: string;
  const movies: Awaited<ReturnType<typeof encryptedMovie>>[] = [];
  const traffic: { host: string; path: string; cookie: string; at: number }[] = [];
  const verificationCounts = [0, 0]; 
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ppv-browser-"));
    for (const [k, v] of Object.entries(playbackEnv(root))) vi.stubEnv(k, v);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${root}/tls.key`, "-out", `${root}/tls.crt`, "-days", "1", "-subj", "/CN=video.test", "-addext", "subjectAltName=DNS:app.video.test,DNS:media.video.test"], { stdio: "pipe" });
    const bundle = await build({ entryPoints: ["tests/fixtures/video-playback-browser.ts"], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022" });
    server = createServer({ key: await readFile(`${root}/tls.key`), cert: await readFile(`${root}/tls.crt`) }, async (req, res) => {
      try {
        const host = req.headers.host!, url = new URL(`https://${host}${req.url}`);
        traffic.push({ host, path: url.pathname, cookie: req.headers.cookie || "", at: Date.now() });
        const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>,
          ...(req.method === "POST" ? { body: Readable.toWeb(req), duplex: "half" } : {}) } as RequestInit);
        let response: Response;
        if (url.pathname === "/") response = new Response('<!doctype html><html><body><button>Play</button><video controls playsinline></video><script src="/player.js"></script></body></html>', { headers: { "Content-Type": "text/html", "Content-Security-Policy": `default-src 'self'; script-src 'self'; connect-src 'self' ${mediaOrigin}; media-src blob:; style-src 'self'` } });
        else if (url.pathname === "/player.js") response = new Response(bundle.outputFiles[0].text, { headers: { "Content-Type": "text/javascript" } });
        else if (url.pathname === "/api/video-delivery/grant") response = req.method === "OPTIONS" ? await OPTIONS(request) : await grantPost(request);
        else if (url.pathname.startsWith("/api/video-delivery/objects/")) response = await objectGet(request, { params: Promise.resolve({ key: url.pathname.slice("/api/video-delivery/objects/".length).split("/") }) });
        else if (/^\/api\/media\/\d\/playback-session$/.test(url.pathname)) {
          const id = Number(url.pathname.split("/")[3]); verificationCounts[id]++;
          if (!req.headers.cookie?.includes("satsrail_macaroons=paid-fixture")) response = Response.json({ error: "ACCESS_DENIED" }, { status: 401 });
          else {
            const session = movies[id].session, now = Date.now(), expiresAt = Math.floor((now + 15000) / 1000) * 1000;
            response = Response.json({ ...session, serverTime: now, expiresAt, grant: issueGrant(deliveryConfig(), session.prefix, expiresAt) }, { headers: { "Cache-Control": "no-store" } });
          }
        } else response = new Response(null, { status: 404 });
        const headers = Object.fromEntries(response.headers); delete headers["set-cookie"];
        res.writeHead(response.status, { ...headers, ...(response.headers.getSetCookie().length ? { "set-cookie": response.headers.getSetCookie() } : {}) });
        if (response.body && response.ok && /\/segment-/.test(url.pathname)) {
          const body = Buffer.from(await response.arrayBuffer());
          for (let offset = 0; offset < body.length && !res.destroyed; offset += 16384) {
            const part = body.subarray(offset, offset + 16384);
            await new Promise(resolve => setTimeout(resolve, part.length * 1000 / bytesPerSecond));
            res.write(part);
          }
          res.end();
        } else if (response.body) Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res); else res.end();
      } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    appOrigin = `https://app.video.test:${port}`; mediaOrigin = `https://media.video.test:${port}`;
    vi.stubEnv("AUTH_URL", appOrigin); vi.stubEnv("VIDEO_MEDIA_ORIGIN", mediaOrigin);
    await mkdir(`${root}/audio`); await mkdir(`${root}/silent`);
    const { objects } = await adaptiveFixture(`${root}/audio`, segment, fixtureSeconds, "gaps");
    const silent = await adaptiveFixture(`${root}/silent`, segment, 40, "silent");
    const storage = new LocalVideoStorage(path.join(root, "objects-root")); await storage.check(); vi.stubEnv("VIDEO_LOCAL_ROOT", path.join(root, "objects-root"));
    movies.push(await encryptedMovie(storage, objects), await encryptedMovie(storage, silent.objects));
    browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--host-resolver-rules=MAP *.video.test 127.0.0.1", "--no-proxy-server"] });
  }, 120000);
  afterAll(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
  it("switches quality in one player, seeks, pauses, adapts to a slower link and recovers", async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies([{ name: "satsrail_macaroons", value: "paid-fixture", url: appOrigin, httpOnly: true, secure: true, sameSite: "Lax" }]);
    const a = await context.newPage(), b = await context.newPage();
    const errors: string[] = []; a.on("pageerror", e => errors.push(e.message)); b.on("pageerror", e => errors.push(e.message));
    async function open(page: typeof a, id: number) {
      await page.goto(`${appOrigin}/?movie=${id}`); await page.locator("button").click();
      await page.waitForFunction(() => window.testPlayer.ready || window.testPlayer.errors.length, null, { timeout: 20000 });
      expect(await page.evaluate(() => window.testPlayer.errors)).toEqual([]);
    }
    await open(a, 0); await open(b, 1);
    for (const page of [a, b]) {
      await page.evaluate(() => { const t = window.testPlayer; t.handle!.quality(t.qualities.at(-1)!.options.find(o => o.height === 720)!.id); });
      await page.waitForFunction(() => document.querySelector("video")!.videoHeight === 720, null, { timeout: 25000 });
    }
    await a.evaluate(() => { const t = window.testPlayer; t.handle!.quality(t.qualities.at(-1)!.options.find(o => o.height === 360)!.id); });
    await a.waitForFunction(() => document.querySelector("video")!.videoHeight === 360, null, { timeout: 25000 });
    const continuity = await a.evaluate(() => ({ waiting: window.testPlayer.waiting, blackFrames: window.testPlayer.blackFrames, heights: window.testPlayer.heights, frames: window.testPlayer.frames }));
    expect(continuity.waiting).toEqual([]); expect(continuity.blackFrames).toBe(0);
    expect(continuity.heights).toContain(720); expect(continuity.heights).toContain(360);
    expect(await b.evaluate(() => window.testPlayer.waiting)).toEqual([]);
    for (const target of [12, 45, 5]) {
      await a.evaluate(t => { const v = document.querySelector("video")!; v.currentTime = t; void v.play(); }, target);
      await a.waitForFunction(t => document.querySelector("video")!.currentTime > t + 1, target);
    }
    await a.evaluate(() => document.querySelector("video")!.pause());
    const pausedAt = await a.evaluate(() => document.querySelector("video")!.currentTime);
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(await a.evaluate(() => document.querySelector("video")!.currentTime)).toBe(pausedAt);
    await b.evaluate(() => window.testPlayer.handle!.destroy());
    await a.evaluate(() => { window.testPlayer.handle!.quality("auto"); void document.querySelector("video")!.play(); });
    await a.waitForFunction(() => { const q = window.testPlayer.qualities.at(-1)!; return q.automatic && q.options.find(o => o.id === q.activeId)?.height === 720; }, null, { timeout: 25000 });
    await a.waitForFunction(() => document.querySelector("video")!.videoHeight === 720, null, { timeout: 25000 });
    bytesPerSecond = 160 * 1024;
    await a.waitForFunction(() => { const q = window.testPlayer.qualities.at(-1)!; return q.automatic && q.options.find(o => o.id === q.activeId)!.height < 720; }, null, { timeout: 45000 });
    const reduced = await a.evaluate(() => { const q = window.testPlayer.qualities.at(-1)!; return q.options.find(o => o.id === q.activeId)!.height; });
    await a.waitForFunction(height => document.querySelector("video")!.videoHeight === height, reduced, { timeout: 25000 });
    bytesPerSecond = 2 * 1024 ** 2;
    await a.waitForFunction(() => { const q = window.testPlayer.qualities.at(-1)!; return q.automatic && q.options.find(o => o.id === q.activeId)?.height === 720; }, null, { timeout: 30000 });
    await a.waitForFunction(() => document.querySelector("video")!.videoHeight === 720, null, { timeout: 25000 }).catch(async error => {
      console.error(await a.evaluate(() => { const v = document.querySelector("video")!; return { currentTime: v.currentTime, duration: v.duration, ended: v.ended, height: v.videoHeight, quality: window.testPlayer.qualities.at(-1) }; }));
      throw error;
    });
    const metrics = await a.evaluate(() => ({ maxBuffer: window.testPlayer.maxBuffer, errors: window.testPlayer.errors, states: window.testPlayer.states, blackFrames: window.testPlayer.blackFrames }));
    expect(metrics.maxBuffer).toBeLessThan(45); expect(metrics.errors).toEqual([]); expect(metrics.states).not.toContain("error"); expect(metrics.blackFrames).toBe(0);
    expect(errors).toEqual([]); expect(traffic.filter(t => t.host.startsWith("media.")).every(t => !t.cookie.includes("satsrail_macaroons"))).toBe(true);
    await a.evaluate(() => window.testPlayer.handle!.destroy());
    const report = { browser: browser.version(), segmentSeconds: segment, fixtureSeconds, silentFixtureSeconds: 40, continuity, ...metrics, automaticReducedHeight: reduced, decodedReducedHeight: reduced, recoveredHeight: 720, verificationCounts, tests: ["manual switching without buffer clearing", "silent video", "filled audio/video gaps", "repeat seeking", "pause/resume", "automatic bandwidth decrease/recovery", "no payment cookie on media host"] };
    if (process.env.VIDEO_ADAPTIVE_REPORT) await writeFile(`${process.env.VIDEO_ADAPTIVE_REPORT}-${segment}s.json`, JSON.stringify(report, null, 2) + "\n");
    await context.close();
  }, 180000);
});
