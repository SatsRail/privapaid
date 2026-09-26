import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deliveryConfig } from "@/lib/video/delivery-config";
import { attemptPrefix, checkGrant, issueGrant } from "@/lib/video/delivery-grant";
import { openDescriptor, decryptObject, readCatalog } from "@/lib/video/browser-crypto";
import { PlaybackLease } from "@/lib/video/browser-session";
import { LocalVideoStorage } from "@/lib/video/storage/local";
import { encryptedMovie, playbackEnv } from "../../helpers/video-playback";
import { POST as grantPost } from "@/app/api/video-delivery/grant/route";
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "ppv-playback-")); for (const [k, v] of Object.entries(playbackEnv(root))) vi.stubEnv(k, v); });
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
describe("private playback delivery", () => {
  it("requires a separate first-party hostname, production TLS/S3, and bounded grants", () => {
    const env = { ...process.env };
    for (const changes of [ { VIDEO_MEDIA_ORIGIN: env.AUTH_URL }, { VIDEO_MEDIA_ORIGIN: "https://foreign.example.org" },
      { VIDEO_MEDIA_ORIGIN: "http://media.video.test" }, { NODE_ENV: "production" }, { VIDEO_DELIVERY_TTL_SECONDS: "301" },
      { AUTH_URL: "https://app.github.io", VIDEO_MEDIA_ORIGIN: "https://media.github.io" } ]) {
      expect(() => deliveryConfig({ ...env, ...changes } as NodeJS.ProcessEnv)).toThrow();
    }
    expect(deliveryConfig().mediaOrigin).toBe("https://media.video.test");
  });
  it("signs only an attempt prefix, rejects alterations and expiry, and installs host-only scoped cookies", async () => {
    const config = deliveryConfig(), prefix = attemptPrefix(randomUUID(), randomUUID(), randomUUID()), expiresAt = Math.floor(Date.now() / 1000) * 1000 + 12000;
    const grant = issueGrant(config, prefix, expiresAt);
    expect(checkGrant(config, grant).prefix).toBe(prefix);
    expect(() => checkGrant(config, grant, expiresAt)).toThrow();
    expect(() => checkGrant(config, { ...grant, "CloudFront-Key-Pair-Id": "wrong" })).toThrow();
    expect(() => checkGrant(config, { ...grant, "CloudFront-Policy": grant["CloudFront-Policy"].slice(1) })).toThrow();
    const res = await grantPost(new Request(config.grantUrl, { method: "POST", headers: { Origin: config.appOrigin }, body: JSON.stringify(grant) }));
    expect(res.status).toBe(204);
    const cookies = res.headers.getSetCookie(); expect(cookies).toHaveLength(4);
    for (const cookie of cookies) { expect(cookie).toContain(`Path=/api/video-delivery/objects/${prefix}/`); expect(cookie).toContain("HttpOnly; SameSite=Lax; Secure"); expect(cookie).not.toContain("Domain="); }
    expect((await grantPost(new Request(config.grantUrl, { method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify(grant) }))).status).toBe(403);
  });
  it("unwraps the real PPV1 descriptor and catalog and rejects wrong keys, substituted identities and tampered segments", async () => {
    const storage = new LocalVideoStorage(root); await storage.check();
    const movie = await encryptedMovie(storage, { "play.mpd": Buffer.from("manifest"), "init-0.mp4": Buffer.from("video bytes") });
    const { descriptor, root: key } = await openDescriptor(movie.session); expect(key.extractable).toBe(false);
    const catalog = readCatalog(await decryptObject(key, descriptor, "catalog.json", new Uint8Array(movie.encrypted["catalog.json"]), descriptor.catalog.sha256), descriptor);
    expect(catalog.size).toBe(2);
    await expect(openDescriptor({ ...movie.session, key_fingerprint: "0".repeat(64) })).rejects.toThrow();
    await expect(openDescriptor({ ...movie.session, product_id: randomUUID() })).rejects.toThrow();
    await expect(openDescriptor({ ...movie.session, version: randomUUID() })).rejects.toThrow();
    const wire = new Uint8Array(movie.encrypted["init-0.mp4"]); wire[20] ^= 1;
    await expect(decryptObject(key, descriptor, "init-0.mp4", wire, catalog.get("init-0.mp4")!.encryptedSha256)).rejects.toThrow();
    expect(wire.every(n => n === 0)).toBe(true);
  });
  it("deduplicates renewal, honors Retry-After without extending access, and stops on denial", async () => {
    const store = new LocalVideoStorage(root); await store.check();
    const { session } = await encryptedMovie(store, { "play.mpd": Buffer.from("m"), "init-0.mp4": Buffer.from("i") });
    let mode = "ok", verifies = 0, grants = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === session.grantUrl) { grants++; return new Response(null, { status: 204 }); }
      verifies++;
      if (mode === "outage") return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
      if (mode === "denied") return new Response(null, { status: 401 });
      return Response.json(session);
    }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const states: string[] = [], lease = new PlaybackLease("media", s => states.push(s));
    try {
      await lease.start(); const a = lease.renew(), b = lease.renew(); expect(a).toBe(b); await a;
      expect(verifies).toBe(2); expect(grants).toBe(2);
      mode = "outage"; await expect(lease.renew()).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(16000);
      await expect(lease.ensure()).rejects.toThrow(); expect(verifies).toBe(3); expect(grants).toBe(2);
      expect(states).toContain("expired"); mode = "denied";
      await vi.advanceTimersByTimeAsync(45000); expect(states.at(-1)).toBe("denied");
      await expect(lease.renew()).rejects.toThrow(); expect(grants).toBe(2);
    } finally { lease.destroy(); }
  });
});
