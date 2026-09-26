import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { clearCollections } from "../../helpers/postgres";
import { createChannel, createMedia } from "../../helpers/factories";
import { unwrapDek } from "@/lib/content-dek";
import { createUpload, queueUploadedVersion, recordReadyVersion, publishVersion, cancelVersion, beginVersionDeletion, listAssets } from "@/lib/video/assets";
import { enqueueProbe, claimJob, heartbeat, completeJob, failJob, attemptPrefix, workerHeartbeat, type Lease } from "@/lib/video/jobs";
import { LocalVideoStorage } from "@/lib/video/storage/local";
import { runNextJob } from "@/lib/video/worker";
import { videoReadiness } from "@/lib/video/readiness";
import { storageIdentity, videoConfig } from "@/lib/video/config";
const auth = vi.hoisted(() => ({ status: 200 }));
vi.mock("@/lib/auth-helpers", () => ({ requireOwnerApi: async () => auth.status === 200 ? { id: "merchant-owner", role: "owner" } : NextResponse.json({ error: "Forbidden" }, { status: auth.status }) }));
import { GET, POST } from "@/app/api/admin/video-pipeline/route";
import { GET as capacityGET } from "@/app/api/admin/video-pipeline/capacity/route";
import { GET as assetsGET } from "@/app/api/admin/video-pipeline/assets/route";
let root: string;
const scope = "a".repeat(64);
const probe = () => enqueueProbe(`probe:${scope}:${Math.floor(Math.random() * 1e12)}`);
async function version(mediaId?: string) {
  const id = mediaId || (await createMedia((await createChannel()).id)).id;
  return createUpload({ mediaId: id, ownerId: "merchant-owner", expectedBytes: BigInt(100), provider: "local", segmentSeconds: 4 });
}
async function queued(mediaId?: string) {
  const v = await version(mediaId);
  await prisma.videoUploadSession.update({ where: { versionId: v.id }, data: { receivedBytes: BigInt(100), sourceSha256: "b".repeat(64) } });
  await queueUploadedVersion(v.id, "merchant-owner");
  return v;
}
const expire = (job: Lease) => prisma.$executeRaw`UPDATE "VideoJob" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE id = ${job.id}::uuid`;
const output = (job: Lease, prefix: string) => ({ manifestKey: `${attemptPrefix(job, prefix)}/manifest.bin`, manifestSha256: "c".repeat(64), objectCount: 10, encryptedBytes: BigInt(1000), durationMs: BigInt(42000) });
beforeAll(async () => {
  // Real migrations, including CHECK/composite FK constraints; db push alone
  // cannot validate those. TEST_DATABASE_URL must identify a disposable DB.
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
  root = await mkdtemp(path.join(tmpdir(), "ppv-foundations-"));
  execFileSync("npm", ["run", "build:video-worker"], { stdio: "pipe" });
});
beforeEach(async () => {
  await clearCollections(); auth.status = 200;
  vi.stubEnv("AUTH_URL", "https://shop.test");
  vi.stubEnv("VIDEO_PIPELINE_ENABLED", "true"); vi.stubEnv("VIDEO_LOCAL_ROOT", root); vi.stubEnv("VIDEO_STORAGE_PROVIDER", "local");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await rm(root, { recursive: true, force: true }); await prisma.$disconnect(); });
describe("video foundation migrations and state", () => {
  it("wraps per-version keys, keeps metadata bounded and paginates without keys", async () => {
    const v = await version(); expect(unwrapDek(v.wrappedRootKey)).toHaveLength(32);
    expect(v.storagePrefix).toContain(v.id); expect(v.upload!.ownerId).toBe("merchant-owner");
    await version(); const page = await listAssets(1); expect(page.items).toHaveLength(1); expect(page.cursor).toBeTruthy();
    expect((await listAssets(1, page.cursor!)).items[0].id).not.toBe(page.items[0].id);
    expect(JSON.stringify(page)).not.toContain(v.wrappedRootKey);
    await expect(prisma.videoUploadSession.update({ where: { versionId: v.id }, data: { receivedBytes: BigInt(101) } })).rejects.toThrow();
    const other = await version();
    await expect(prisma.videoAsset.update({ where: { id: v.assetId }, data: { publishedVersionId: other.id } })).rejects.toThrow();
  });
  it("does not queue incomplete uploads or uploads belonging to another owner", async () => {
    const v = await version();
    await expect(queueUploadedVersion(v.id, "merchant-owner")).rejects.toThrow("UPLOAD_INCOMPLETE");
    await prisma.videoUploadSession.update({ where: { versionId: v.id }, data: { receivedBytes: BigInt(100), sourceSha256: "a".repeat(64) } });
    await expect(queueUploadedVersion(v.id, "intruder")).rejects.toThrow("UPLOAD_INCOMPLETE");
    const a = await queueUploadedVersion(v.id, "merchant-owner");
    expect((await queueUploadedVersion(v.id, "merchant-owner")).id).toBe(a.id);
  });
  it("gives two concurrent workers only one lease", async () => {
    const job = await probe();
    const leases = await Promise.all([claimJob(["storage_probe"], 15), claimJob(["storage_probe"], 15)]);
    expect(leases.filter(Boolean)).toHaveLength(1); expect(leases.find(Boolean)!.id).toBe(job.id);
    await heartbeat(leases.find(Boolean)!, 15);
  });
  it("backs off failed attempts and retries only after the durable deadline", async () => {
    await probe(); const first = (await claimJob(["storage_probe"], 15))!;
    await failJob(first, "STORAGE_UNAVAILABLE");
    expect(await claimJob(["storage_probe"], 15)).toBeNull();
    await prisma.$executeRaw`UPDATE "VideoJob" SET "availableAt" = clock_timestamp() - interval '1 second' WHERE id = ${first.id}::uuid`;
    const retried = (await claimJob(["storage_probe"], 15))!;
    expect(retried.attempts).toBe(2); expect(retried.leaseToken).not.toBe(first.leaseToken);
  });
  it("fences stale heartbeat/completion and stale publication after a takeover", async () => {
    const v = await queued(); const first = (await claimJob(["package_asset"], 15))!;
    await expire(first); const second = (await claimJob(["package_asset"], 15))!;
    expect(second.leaseToken).not.toBe(first.leaseToken);
    await expect(heartbeat(first, 15)).rejects.toThrow("LEASE_LOST");
    await expect(completeJob(first)).rejects.toThrow("LEASE_LOST");
    await expect(recordReadyVersion(first, output(first, v.storagePrefix))).rejects.toThrow("LEASE_LOST");
    await expect(recordReadyVersion(second, output(first, v.storagePrefix))).rejects.toThrow("OUTPUT_INVALID");
    await recordReadyVersion(second, output(second, v.storagePrefix));
    expect((await prisma.videoAsset.findUniqueOrThrow({ where: { id: v.assetId } })).publishedVersionId).toBeNull();
    expect(await publishVersion(v.id)).toBe(true);
  });
  it("keeps the published version after a failed replacement and ignores late older output", async () => {
    const media = await createMedia((await createChannel()).id);
    const a = await queued(media.id); const aJob = (await claimJob(["package_asset"], 15))!;
    await recordReadyVersion(aJob, output(aJob, a.storagePrefix)); await publishVersion(a.id);
    const b = await queued(media.id); await prisma.videoJob.update({ where: { versionId: b.id }, data: { maxAttempts: 1 } });
    await failJob((await claimJob(["package_asset"], 15))!, "STORAGE_UNAVAILABLE");
    expect((await prisma.videoAsset.findUniqueOrThrow({ where: { id: a.assetId } })).publishedVersionId).toBe(a.id);
    const c = await queued(media.id); const cJob = (await claimJob(["package_asset"], 15))!;
    const d = await queued(media.id); const dJob = (await claimJob(["package_asset"], 15))!;
    await recordReadyVersion(dJob, output(dJob, d.storagePrefix)); expect(await publishVersion(d.id)).toBe(true);
    await recordReadyVersion(cJob, output(cJob, c.storagePrefix)); expect(await publishVersion(c.id)).toBe(false);
    expect((await prisma.videoAsset.findUniqueOrThrow({ where: { id: a.assetId } })).publishedVersionId).toBe(d.id);
  });
  it("bounds retries, cancels active leases and removes publication before deletion", async () => {
    const v = await queued(); await prisma.videoJob.update({ where: { versionId: v.id }, data: { maxAttempts: 1 } });
    const job = (await claimJob(["package_asset"], 15))!; await expire(job);
    expect(await claimJob(["package_asset"], 15)).toBeNull();
    expect((await prisma.videoAssetVersion.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("failed");
    const next = await queued(); const active = (await claimJob(["package_asset"], 15))!;
    await cancelVersion(next.id); await expect(completeJob(active)).rejects.toThrow("LEASE_LOST");
    const ready = await queued(); const lease = (await claimJob(["package_asset"], 15))!;
    await recordReadyVersion(lease, output(lease, ready.storagePrefix));
    await Promise.all([publishVersion(ready.id), beginVersionDeletion(ready.id)]);
    expect((await prisma.videoAsset.findUniqueOrThrow({ where: { id: ready.assetId } })).publishedVersionId).toBeNull();
    expect(await publishVersion(ready.id)).toBe(false);
  });
  it("recovers after killing an owned worker process immediately after claim", async () => {
    const pending = await probe();
    const child = fork(path.resolve("tests/fixtures/video-worker-claim.ts"), { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let old: Lease;
    try {
      const [message] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("claim child exited"); })]);
      old = message as Lease; expect(old.id).toBe(pending.id);
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    } finally { if (child.exitCode === null) child.kill("SIGKILL"); }
    await expire(old!); const restarted = (await claimJob(["storage_probe"], 15))!;
    expect(restarted.attempts).toBe(2); expect(restarted.leaseToken).not.toBe(old!.leaseToken);
    await completeJob(restarted); await expect(completeJob(old!)).rejects.toThrow("LEASE_LOST");
  });
  it("runs an encrypted probe through the built worker process", async () => {
    const id = storageIdentity(videoConfig()); const queued = await enqueueProbe(`probe:${id}:1`);
    execFileSync(process.execPath, ["build/video-worker.cjs", "--once"], { env: process.env, stdio: "pipe", timeout: 20000 });
    expect((await prisma.videoJob.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe("completed");
    expect((await new LocalVideoStorage(root).list(`probes/${queued.id}`, 10)).objects).toHaveLength(0);
  });
});
describe("owner setup API and default-off behavior", () => {
  const req = () => new NextRequest("https://shop.test/api/admin/video-pipeline", { method: "POST", headers: { origin: "https://shop.test" } });
  it("requires owner auth, explicit origin and opt-in", async () => {
    auth.status = 401; expect((await GET()).status).toBe(401); expect((await POST(req())).status).toBe(401);
    auth.status = 403; expect((await GET()).status).toBe(403);
    auth.status = 200; expect((await POST(new NextRequest(req().url, { method: "POST" }))).status).toBe(403);
    vi.stubEnv("VIDEO_PIPELINE_ENABLED", "false"); vi.stubEnv("CONTENT_KEK", "");
    expect(await (await GET()).json()).toEqual({ enabled: false, ready: false, code: "VIDEO_DISABLED" });
    expect((await POST(req())).status).toBe(404); expect(await prisma.videoJob.count()).toBe(0);
    expect((await assetsGET(new NextRequest(req().url + "/assets"))).status).toBe(404);
  });
  it("protects capacity accounting and bounds searchable catalog pages", async () => {
    const request = new NextRequest("https://shop.test/api/admin/video-pipeline/capacity");
    auth.status = 403; expect((await capacityGET(request)).status).toBe(403);
    auth.status = 200;
    const a = await queued(); const b = await version();
    await prisma.media.update({ where: { id: (await prisma.videoAsset.findUniqueOrThrow({ where: { id: a.assetId } })).mediaId }, data: { name: "The Aurora" } });
    await prisma.videoAssetVersion.update({ where: { id: a.id }, data: { reservedBytes: 5000, encryptedBytes: 1200 } });
    await prisma.videoAssetVersion.update({ where: { id: b.id }, data: { reservedBytes: 7000 } });
    const response = await capacityGET(request), body = await response.json();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({ pending: 2, queued: 1, processing: 0, reservedBytes: "12000", encryptedOutputBytes: "1200", readiness: { ready: false, workerCount: 0 } });
    const page = await (await assetsGET(new NextRequest("https://shop.test/api/admin/video-pipeline/assets?q=aurORA&limit=1"))).json();
    expect(page.items).toHaveLength(1); expect(page.items[0].media.name).toBe("The Aurora");
    expect(page.items[0].versions).toHaveLength(1);
    expect(JSON.stringify(page)).not.toMatch(/wrappedRootKey|storagePrefix|encryptedDescriptor/);
    await prisma.media.update({ where: { id: page.items[0].mediaId }, data: { deletedAt: new Date() } });
    expect((await listAssets(25, undefined, "aurora")).items).toEqual([]);
    expect((await assetsGET(new NextRequest(`https://shop.test/api/admin/video-pipeline/assets?q=${"a".repeat(101)}`))).status).toBe(400);
    vi.stubEnv("VIDEO_PIPELINE_ENABLED", "false"); expect((await capacityGET(request)).status).toBe(404);
  });
  it("coalesces repeated probes and reports missing workers/keys and pagination errors", async () => {
    expect((await videoReadiness()).code).toBe("VIDEO_WORKER_MISSING");
    const proxied = new NextRequest("http://internal:3000/api/admin/video-pipeline", { method: "POST", headers: { origin: "https://shop.test" } });
    expect((await POST(proxied)).status).toBe(202);
    const first = await (await POST(req())).json(); const second = await (await POST(req())).json(); expect(second.id).toBe(first.id);
    const storage = new LocalVideoStorage(root); await storage.check(); await runNextJob(storage, 15);
    await workerHeartbeat(randomUUID(), storageIdentity(videoConfig()));
    expect((await videoReadiness()).ready).toBe(true);
    const actualKey = process.env.CONTENT_KEK!; vi.stubEnv("CONTENT_KEK", Buffer.alloc(32, 1).toString("base64"));
    expect((await videoReadiness()).ready).toBe(false); vi.stubEnv("CONTENT_KEK", actualKey);
    vi.stubEnv("VIDEO_LOCAL_ROOT", path.join(root, "different-store")); expect((await videoReadiness()).ready).toBe(false);
    expect((await assetsGET(new NextRequest(req().url + "/assets?limit=10000"))).status).toBe(400);
    vi.stubEnv("CONTENT_KEK", ""); expect((await videoReadiness()).code).toBe("VIDEO_CONTENT_KEK_REQUIRED");
  });
});
