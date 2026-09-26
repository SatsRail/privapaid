import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:https";
import { Readable } from "node:stream";
import { readFile, writeFile, readdir, mkdtemp, rm } from "node:fs/promises";
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
import { encryptedMovie, playbackEnv } from "../../helpers/video-playback";
// Opt-in real browser proof. The session response models a paid SatsRail
// contract; the companion integration test exercises the real session handler.
// No actual payment, live CloudFront, physical Safari or long-film gate claimed.
describe.skipIf(process.env.VIDEO_BROWSER_TEST !== "true")("encrypted playback in Chrome", () => {
  let root: string, browser: Browser, server: ReturnType<typeof createServer>, appOrigin: string, mediaOrigin: string;
  const movies: Awaited<ReturnType<typeof encryptedMovie>>[] = [];
  const traffic: { host: string; path: string; cookie: string; at: number }[] = [];
  const verificationCounts = [0, 0]; let denyRenewal = false;
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
          if (!req.headers.cookie?.includes("satsrail_macaroons=paid-fixture") || denyRenewal) response = Response.json({ error: "ACCESS_DENIED" }, { status: 401 });
          else {
            const session = movies[id].session, now = Date.now(), expiresAt = Math.floor((now + 15000) / 1000) * 1000;
            response = Response.json({ ...session, serverTime: now, expiresAt, grant: issueGrant(deliveryConfig(), session.prefix, expiresAt) }, { headers: { "Cache-Control": "no-store" } });
          }
        } else response = new Response(null, { status: 404 });
        const headers = Object.fromEntries(response.headers); delete headers["set-cookie"];
        res.writeHead(response.status, { ...headers, ...(response.headers.getSetCookie().length ? { "set-cookie": response.headers.getSetCookie() } : {}) });
        if (response.body) Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res); else res.end();
      } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    appOrigin = `https://app.video.test:${port}`; mediaOrigin = `https://media.video.test:${port}`;
    vi.stubEnv("AUTH_URL", appOrigin); vi.stubEnv("VIDEO_MEDIA_ORIGIN", mediaOrigin);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "28", "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-bf", "0", "-g", "120", "-keyint_min", "120", "-sc_threshold", "0", "-c:a", "aac", "-use_template", "1", "-use_timeline", "1", "-seg_duration", "4", "-init_seg_name", "init-$RepresentationID$.mp4", "-media_seg_name", "segment-$RepresentationID$-$Number%05d$.m4s", "-f", "dash", `${root}/play.mpd`], { stdio: "pipe" });
    const objects: Record<string, Buffer> = {};
    for (const name of await readdir(root)) if (/^(play\.mpd|init-|segment-)/.test(name)) objects[name] = await readFile(path.join(root, name));
    const storage = new LocalVideoStorage(path.join(root, "objects-root")); await storage.check(); vi.stubEnv("VIDEO_LOCAL_ROOT", path.join(root, "objects-root"));
    movies.push(await encryptedMovie(storage, objects), await encryptedMovie(storage, objects));
    browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--host-resolver-rules=MAP *.video.test 127.0.0.1", "--no-proxy-server"] });
  }, 60000);
  afterAll(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
  it("plays continuously across renewals, seeks, isolates two movie cookies, and blocks expired warm requests", async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies([{ name: "satsrail_macaroons", value: "paid-fixture", url: appOrigin, httpOnly: true, secure: true, sameSite: "Lax" }]);
    const a = await context.newPage(), b = await context.newPage();
    const errors: string[] = []; a.on("pageerror", e => errors.push(e.message)); b.on("pageerror", e => errors.push(e.message));
    await a.goto(`${appOrigin}/?movie=0`); await a.locator("button").click();
    await a.waitForFunction(() => window.testPlayer.ready || window.testPlayer.errors.length > 0, null, { timeout: 20000 });
    expect(await a.evaluate(() => window.testPlayer.errors)).toEqual([]);
    await b.goto(`${appOrigin}/?movie=1`); await b.locator("button").click();
    await b.waitForFunction(() => window.testPlayer.ready || window.testPlayer.errors.length > 0, null, { timeout: 20000 });
    expect(await b.evaluate(() => window.testPlayer.errors)).toEqual([]);
    await a.waitForFunction(() => document.querySelector("video")!.ended, null, { timeout: 40000 });
    const metrics = await a.evaluate(() => ({ frames: window.testPlayer.frames, waiting: window.testPlayer.waiting, maxBuffer: window.testPlayer.maxBuffer, states: window.testPlayer.states }));
    expect(metrics.frames).toBeGreaterThan(500); expect(metrics.waiting).toEqual([]); expect(metrics.maxBuffer).toBeLessThan(36);
    expect(metrics.states).not.toContain("error"); expect(verificationCounts[0]).toBeGreaterThanOrEqual(3);
    expect(verificationCounts[0]).toBeLessThan(7); expect(verificationCounts[1]).toBeLessThan(7);
    const movieCookies = (await context.cookies()).filter(c => c.name.startsWith("CloudFront-"));
    expect(movieCookies).toHaveLength(8); expect(new Set(movieCookies.map(c => c.path)).size).toBe(2);
    expect(movieCookies.every(c => c.httpOnly && c.secure && c.domain === "media.video.test")).toBe(true);
    expect(traffic.filter(t => t.host.startsWith("media.")).every(t => !t.cookie.includes("satsrail_macaroons"))).toBe(true);
    await a.evaluate(() => { const v = document.querySelector("video")!; v.currentTime = 9; void v.play(); });
    await a.waitForFunction(() => document.querySelector("video")!.currentTime > 11);
    const target = `${movies[0].session.objectBase}init-0.mp4`;
    expect(await a.evaluate(async url => (await fetch(url, { credentials: "include" })).status, target)).toBe(200);
    expect(await a.evaluate(async url => (await fetch(url, { credentials: "omit" })).status, target)).toBe(403);
    await a.evaluate(() => window.testPlayer.handle!.destroy()); await b.evaluate(() => window.testPlayer.handle!.destroy());
    const callsAtDestroy = verificationCounts[0] + verificationCounts[1];
    // Let actual browser cookies expire; warm object access must still fail.
    denyRenewal = true; await new Promise(resolve => setTimeout(resolve, 16000));
    expect(await a.evaluate(async url => (await fetch(url, { credentials: "include" })).status, target)).toBe(403);
    expect(verificationCounts[0] + verificationCounts[1]).toBe(callsAtDestroy); expect(errors).toEqual([]);
    const report = { browser: browser.version(), seconds: 28, ...metrics, verificationCounts, movieCookies: movieCookies.length, paymentCookieLeaked: false, tests: ["continuous playback", "seek", "renewal", "two movie cookie scopes", "expiry after warm read", "teardown"] };
    if (process.env.VIDEO_BROWSER_REPORT) await writeFile(process.env.VIDEO_BROWSER_REPORT, JSON.stringify(report, null, 2) + "\n");
    await context.close();
  }, 90000);
});
