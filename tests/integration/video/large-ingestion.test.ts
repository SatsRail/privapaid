import { expect, it } from "vitest";
import { fork, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, rm, statfs, readdir, open, readFile, writeFile, chmod, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { createMedia, createChannel, createSettings } from "../../helpers/factories";
import { clearCollections } from "../../helpers/postgres";
import { encryptSecretKey } from "@/lib/encryption";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { unwrapDek } from "@/lib/content-dek";
import { sha256 } from "@/lib/video/format";
import { PART_BYTES } from "@/lib/video/ingestion-config";
import { LocalVideoStorage } from "@/lib/video/storage/local";
import { ownedUpload } from "@/lib/video/uploads";

// Opt in: writes 10 GiB of real ciphertext and deletes only its own temp root.
it.skipIf(process.env.VIDEO_LARGE_TEST !== "true")("resumes an HTTP upload across server/client restarts and fences a killed encoder", async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) throw new Error("Use an explicit disposable test database");
  const total = Number(process.env.VIDEO_LARGE_TEST_BYTES || 10 * 1024 ** 3), disk = await statfs(tmpdir());
  if (disk.bavail * disk.bsize < total + 2 * 1024 ** 3) throw new Error("Need 12 GiB free for the 10 GiB test");
  await clearCollections();
  const root = await mkdtemp(path.join(tmpdir(), "ppv-large-")), children = new Set<ChildProcess>();
  const key = randomBytes(32), fingerprint = sha256(key.toString("base64url")), remoteId = randomUUID();
  let railCalls = 0;
  const rail = createServer((req, res) => {
    railCalls++;
    req.url = req.url?.replace(/^\/api\/v1/, "");
    if (req.method !== "GET" || ![`/m/products/${remoteId}`, `/m/products/${remoteId}/key`].includes(req.url!)) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url!.endsWith("/key") ? { key: key.toString("base64url"), key_fingerprint: fingerprint } : { id: remoteId, status: "active", old_key: null }));
  });
  await new Promise<void>(resolve => rail.listen(0, "127.0.0.1", resolve));
  const railUrl = `http://127.0.0.1:${(rail.address() as { port: number }).port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, VIDEO_PIPELINE_ENABLED: "true", VIDEO_STORAGE_PROVIDER: "local", VIDEO_LOCAL_ROOT: root,
    SATSRAIL_API_URL: railUrl, VIDEO_MAX_STORAGE_BYTES: String(100 * 1024 ** 3) };
  function child(file: string, args: string[] = []) {
    const value = fork(path.resolve("build", file), args, { env, execArgv: ["--max-old-space-size=256"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    value.stdout?.resume(); value.stderr?.resume(); children.add(value); return value;
  }
  function message(child: ChildProcess): Promise<Record<string, string | number | boolean>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clear(); reject(new Error("Harness message timed out")); }, 180000);
      const received = (value: Record<string, string | number | boolean>) => { clear(); resolve(value); };
      const exited = () => { clear(); reject(new Error("Harness exited before acknowledgement")); };
      function clear() { clearTimeout(timer); child.off("message", received); child.off("exit", exited); }
      child.once("message", received); child.once("exit", exited);
    });
  }
  async function stop(child: ChildProcess) { if (child.exitCode !== null || child.signalCode !== null) return; const closed = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await closed; children.delete(child); }
  try {
    execFileSync("node_modules/.bin/esbuild", ["tests/fixtures/video-ingestion-server.ts", "--bundle", "--platform=node", "--packages=external", "--alias:@/lib/auth-helpers=./tests/fixtures/video-owner.ts", "--outfile=build/video-ingestion-server.cjs"], { stdio: "pipe" });
    execFileSync("node_modules/.bin/esbuild", ["tests/fixtures/video-ingestion-worker.ts", "--bundle", "--platform=node", "--packages=external", "--outfile=build/video-ingestion-worker.cjs"], { stdio: "pipe" });
    const adaptive = process.env.VIDEO_ADAPTIVE_CONTAINER === "true";
    const source = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${adaptive ? "1280x720" : "320x180"}:rate=30`,
      ...(adaptive ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"] : []), "-t", adaptive ? "21" : "8.5", "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-bf", "0", ...(adaptive ? ["-c:a", "aac"] : []), "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"], { maxBuffer: adaptive ? 64 * 1024 ** 2 : PART_BYTES });
    if (total < source.length + 16) throw new Error("Fixture upload must fit source and free box");
    // A valid MP4 followed by a large top-level free box; generated per part in
    // memory. Exercises 10 GiB ingress/storage/checksums, not 10 GiB of encoding.
    const header = Buffer.alloc(16); header.writeUInt32BE(1); header.write("free", 4); header.writeBigUInt64BE(BigInt(total - source.length), 8);
    function part(offset: number) {
      const data = Buffer.alloc(Math.min(PART_BYTES, total - offset));
      for (const [start, bytes] of [[0, source], [source.length, header]] as const) {
        const from = Math.max(offset, start), to = Math.min(offset + data.length, start + bytes.length);
        if (to > from) bytes.copy(data, from - offset, from - start, to - start);
      }
      return data;
    }
    const media = await createMedia((await createChannel()).id), envelope = await prisma.mediaEnvelope.findUniqueOrThrow({ where: { mediaId: media.id } });
    const product = await prisma.product.create({ data: { mediaId: media.id, satsrailProductId: remoteId, keyFingerprint: fingerprint } });
    const dek = unwrapDek(envelope.wrappedDek!);
    await prisma.mediaProduct.create({ data: { mediaId: media.id, productId: product.id, keyFingerprint: fingerprint, encryptedDek: encryptSourceUrl(dek.toString("base64url"), key.toString("base64url"), remoteId) } }); dek.fill(0);
    await createSettings({ satsrailApiKeyEncrypted: encryptSecretKey("sk_test_large_video"), satsrailApiUrl: railUrl });
    let server = child("video-ingestion-server.cjs"), origin = String((await message(server)).origin);
    async function request(endpoint: string, options: RequestInit = {}) {
      const response = await fetch(origin + endpoint, { ...options, headers: { origin, ...options.headers } });
      const value = await response.json(); if (!response.ok) throw new Error(`Harness ${response.status}: ${value.error}`); return value;
    }
    const started = Date.now();
    const created = await request("/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mediaId: media.id, productId: product.id, bytes: total, segmentSeconds: 4, clientFingerprint: sha256("large-fixture"), idempotencyKey: randomUUID() }) });
    async function send(from: number, end: number) {
      for (let offset = from; offset < end; offset += PART_BYTES) {
        const data = part(offset);
        try { await request(`/uploads/${created.id}/parts`, { method: "PUT", headers: { "content-type": "application/octet-stream", "upload-offset": String(offset), "x-content-sha256": sha256(data) }, body: data }); }
        finally { data.fill(0); }
      }
    }
    await send(0, total / 2);
    const rss1 = message(server); server.send("rss"); const firstRSS = (await rss1).maxRSSKiB;
    await stop(server);
    server = child("video-ingestion-server.cjs"); origin = String((await message(server)).origin);
    // New client state starts with a server status query, not a cached offset.
    const resumed = await request(`/uploads/${created.id}`); expect(resumed.receivedBytes).toBe(total / 2);
    await request(`/uploads/${created.id}/resume`, { method: "POST" }); await send(resumed.receivedBytes, total);
    await request(`/uploads/${created.id}/complete`, { method: "POST" });
    const rss2 = message(server); server.send("rss"); const secondRSS = (await rss2).maxRSSKiB; await stop(server);
    const uploadMs = Date.now() - started;
    const crash = child("video-ingestion-worker.cjs", ["--crash-boundary"]); expect((await message(crash)).outputWritten).toBe(true); await stop(crash);
    const interrupted = await ownedUpload(created.id, "video-harness-owner");
    expect(interrupted.version.status).toBe("processing"); expect(interrupted.version.encryptedDescriptor).toBeNull(); expect(interrupted.version.asset.publishedVersionId).toBeNull();
    await prisma.$executeRaw`UPDATE "VideoJob" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE "versionId" = ${created.versionId}::uuid`;
    let processed: Record<string, string | number | boolean>;
    if (process.env.VIDEO_DOCKER_TEST === "true") {
      // Synthetic ciphertext only: make this disposable bind mount accessible
      // to the image's UID 1001. Never change permissions on operator storage.
      async function accessible(dir: string) { await chmod(dir, 0o777); for (const entry of await readdir(dir, { withFileTypes: true })) {
        const name = path.join(dir, entry.name); if (entry.isDirectory()) await accessible(name); else await chmod(name, 0o644);
      } }
      await accessible(root);
      const containerEnv = { ...env, DATABASE_URL: env.DATABASE_URL!.replace("127.0.0.1", "host.docker.internal"), SATSRAIL_API_URL: railUrl.replace("127.0.0.1", "host.docker.internal") };
      const args = ["run", "--rm", "--pull=never", "--read-only", "--user", "1001:1001", "--cpus", "2", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "128", "--ulimit", "core=0", "--tmpfs", "/tmp:size=64m,mode=1777", "--cap-drop=ALL", "--security-opt", "no-new-privileges:true", "-v", `${root}:${root}`];
      for (const name of ["DATABASE_URL", "CONTENT_KEK", "SK_ENCRYPTION_KEY", "SATSRAIL_API_URL", "VIDEO_PIPELINE_ENABLED", "VIDEO_STORAGE_PROVIDER", "VIDEO_LOCAL_ROOT"]) args.push("-e", name);
      args.push(process.env.VIDEO_DOCKER_IMAGE || "privapaid-video-worker:phase2-test", "node", "-e",
        "const p=require('node:child_process').spawnSync(process.execPath,['build/video-worker.cjs','--once'],{stdio:'inherit'}); console.log(JSON.stringify({uid:process.getuid(),containerPeakBytes:Number(require('node:fs').readFileSync('/sys/fs/cgroup/memory.peak','utf8'))})); process.exit(p.status||0)");
      const result = await promisify(execFile)("docker", args, { env: containerEnv, timeout: 180000 });
      process.stdout.write(result.stdout); process.stderr.write(result.stderr);
      processed = { ...JSON.parse(result.stdout.trim().split("\n").at(-1)!), maxRSSKiB: 0, container: true };
    } else { const worker = child("video-ingestion-worker.cjs"); processed = await message(worker); }
    const ready = await ownedUpload(created.id, "video-harness-owner"); expect(ready.version.job?.lastErrorCode).toBeNull(); expect(ready.version.status).toBe("ready"); expect(ready.version.job?.attempts).toBe(2);
    expect(ready.version.manifestKey).not.toContain(interrupted.version.job!.leaseToken!);
    let files = 0;
    for (const directory of await readdir(path.join(root, "objects"))) {
      const handle = await open(path.join(root, "objects", directory, "data"));
      try { const prefix = Buffer.alloc(64); await handle.read(prefix); expect(prefix.subarray(0, 4).toString()).toBe("PPV1"); } finally { await handle.close(); }
      const info = await readFile(path.join(root, "objects", directory, "info.json"), "utf8"); expect(info).not.toContain(key.toString("base64url")); files++;
    }
    expect(files).toBeGreaterThanOrEqual(total / PART_BYTES);
    // SIGKILL may interrupt another rendition's atomic ciphertext write.
    // Verify those unpublished remnants, then exercise normal age-based cleanup.
    const temporary = await readdir(path.join(root, "tmp"));
    for (const name of temporary) {
      const dir = path.join(root, "tmp", name); expect(name).toMatch(/^put-/);
      for (const file of await readdir(dir)) {
        expect(["data", "info.json"]).toContain(file);
        if (file === "data") {
          const fd = await open(path.join(dir, file));
          try { const prefix = Buffer.alloc(4), { bytesRead } = await fd.read(prefix); expect(prefix.subarray(0, bytesRead)).toEqual(Buffer.from("PPV1").subarray(0, bytesRead)); }
          finally { await fd.close(); }
        }
      }
      const old = new Date(Date.now() - 25 * 3600_000); await utimes(dir, old, old);
    }
    await new LocalVideoStorage(root).cleanupTemporary(new Date(Date.now() - 24 * 3600_000));
    expect(await readdir(path.join(root, "tmp"))).toHaveLength(0);
    expect(await readdir(path.join(root, "multipart"))).toHaveLength(0);
    expect(Number(firstRSS)).toBeLessThan(512 * 1024); expect(Number(secondRSS)).toBeLessThan(512 * 1024); expect(Number(processed.maxRSSKiB)).toBeLessThan(768 * 1024);
    if (processed.container) { expect(processed.uid).toBe(1001); expect(Number(processed.containerPeakBytes)).toBeLessThan(2 * 1024 ** 3); }
    const { maxRSSKiB, ...runtime } = processed;
    const evidence = { evidence: adaptive ? "phase4-adaptive-container" : "phase2-upload-recovery", profile: ready.version.encodingProfile, ...runtime, crashTemporaryDirs: temporary.length, temporaryCleanup: true, fixtureSeconds: adaptive ? 21 : 8.5, outputObjects: ready.version.objectCount, bytes: total, objects: files, uploadMs, serverRSSKiB: [firstRSS, secondRSS], workerNodeRSSKiB: processed.container ? null : maxRSSKiB, attempts: ready.version.job?.attempts, railCalls };
    process.stdout.write(JSON.stringify(evidence) + "\n");
    if (process.env.VIDEO_CONTAINER_REPORT) await writeFile(process.env.VIDEO_CONTAINER_REPORT, JSON.stringify(evidence, null, 2) + "\n");
  } finally {
    for (const child of children) await stop(child);
    rail.closeAllConnections(); await new Promise<void>(resolve => rail.close(() => resolve()));
    await rm(root, { recursive: true, force: true }); await clearCollections(); await prisma.$disconnect();
  }
}, 20 * 60_000);
