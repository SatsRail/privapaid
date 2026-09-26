import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID, randomBytes, createDecipheriv } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/prisma";
import { createMedia, createChannel } from "../../helpers/factories";
import { clearCollections } from "../../helpers/postgres";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { unwrapDek } from "@/lib/content-dek";
import { LocalVideoStorage } from "@/lib/video/storage/local";
import { sha256, openObject, sealObject, sourceName } from "@/lib/video/format";
import { startUpload, receivePart, completeUpload, resumeUpload, retryUpload, ownedUpload, uploadView, abortUpload, readSourcePart } from "@/lib/video/uploads";
import { PART_BYTES, MAX_SOURCE_BYTES } from "@/lib/video/ingestion-config";
import { videoConfig, storageIdentity } from "@/lib/video/config";
import { runNextJob } from "@/lib/video/worker";
import { claimJob, failJob } from "@/lib/video/jobs";
import { privateMediaBridge } from "@/lib/video/bridge";
import { cleanupStaging } from "@/lib/video/cleanup";
import { verifyProductBinding } from "@/lib/video/product-gate";
import { IngestionError } from "@/lib/video/ingestion-errors";
import { packageVideo } from "@/lib/video/package-job";
import { S3Client } from "@aws-sdk/client-s3";
import { S3VideoStorage } from "@/lib/video/storage/s3";
import { s3ProtocolServer } from "../../helpers/video-s3-server";
const remote = vi.hoisted(() => ({ key: "", fingerprint: "", rotation: false, unavailable: false }));
vi.mock("@/lib/merchant-key", () => ({ getMerchantKey: async () => "sk_test_video" }));
vi.mock("@/lib/satsrail", () => ({ satsrail: {
  getProduct: vi.fn(async () => { if (remote.unavailable) throw new Error("upstream"); return { status: "active", old_key: remote.rotation ? "pending" : null }; }),
  getProductKey: vi.fn(async () => ({ key: remote.key, key_fingerprint: remote.fingerprint })),
} }));
let root: string, storage: LocalVideoStorage, source: Buffer, mediaId: string, productId: string;
const owner = "merchant-owner";
function input(bytes = source.length) { return { mediaId, productId, bytes, segmentSeconds: 4 as const, clientFingerprint: sha256("file-identity"), idempotencyKey: randomUUID() }; }
async function uploadSource(data = source, segmentSeconds: 4 | 10 = 4) {
  const u = await startUpload(owner, { ...input(data.length), segmentSeconds });
  for (let offset = 0; offset < data.length; offset += PART_BYTES) {
    const part = data.subarray(offset, offset + PART_BYTES);
    await receivePart(u.id, owner, offset, sha256(part), Readable.from([part]), storage);
  }
  return completeUpload(u.id, owner);
}
beforeAll(async () => {
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
  source = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8.5", "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-bf", "0", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"], { maxBuffer: PART_BYTES });
  root = await mkdtemp(path.join(tmpdir(), "ppv-ingestion-"));
  storage = new LocalVideoStorage(root); await storage.check();
});
beforeEach(async () => {
  await clearCollections(); remote.rotation = false; remote.unavailable = false;
  const key = randomBytes(32); remote.key = key.toString("base64url"); remote.fingerprint = sha256(remote.key);
  vi.stubEnv("VIDEO_PIPELINE_ENABLED", "true"); vi.stubEnv("VIDEO_LOCAL_ROOT", root); vi.stubEnv("VIDEO_STORAGE_PROVIDER", "local");
  const media = await createMedia((await createChannel()).id); mediaId = media.id;
  const envelope = await prisma.mediaEnvelope.findUniqueOrThrow({ where: { mediaId } });
  const mediaKey = unwrapDek(envelope.wrappedDek!);
  const product = await prisma.product.create({ data: { mediaId, satsrailProductId: randomUUID(), keyFingerprint: remote.fingerprint, productStatus: "active" } }); productId = product.id;
  await prisma.mediaProduct.create({ data: { mediaId, productId, keyFingerprint: remote.fingerprint, encryptedDek: encryptSourceUrl(mediaKey.toString("base64url"), remote.key, product.satsrailProductId) } }); mediaKey.fill(0);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await rm(root, { recursive: true, force: true }); await prisma.$disconnect(); });
describe("resumable encrypted ingestion", () => {
  it("packages through the real S3 SDK against the local protocol double", async () => {
    const server = await s3ProtocolServer();
    const client = new S3Client({ region: "us-east-1", endpoint: server.endpoint, forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" }, maxAttempts: 1 });
    try {
      vi.stubEnv("VIDEO_STORAGE_PROVIDER", "s3"); vi.stubEnv("VIDEO_S3_BUCKET", "bucket"); vi.stubEnv("VIDEO_S3_REGION", "us-east-1"); vi.stubEnv("VIDEO_S3_ENDPOINT", server.endpoint);
      const store = new S3VideoStorage(client, "bucket", "private/"), config = videoConfig(); await store.check();
      const u = await startUpload(owner, input()); await receivePart(u.id, owner, 0, sha256(source), Readable.from([source]), store); await completeUpload(u.id, owner);
      await packageVideo((await claimJob(["package_asset"], 30, storageIdentity(config)))!, store, new AbortController().signal, config);
      expect((await ownedUpload(u.id, owner)).version.status).toBe("ready");
    } finally { client.destroy(); await server.close(); }
  });
  it("requires a real associated key and blocks pending rotation before reservation", async () => {
    const established = remote.fingerprint;
    remote.fingerprint = sha256(Buffer.from(remote.key, "base64url"));
    await expect(startUpload(owner, input())).rejects.toMatchObject({ code: "KEY_STATE_CHANGED" });
    remote.fingerprint = established;
    remote.rotation = true; await expect(startUpload(owner, input())).rejects.toMatchObject({ code: "ROTATION_PENDING" });
    expect(await prisma.videoUploadSession.count()).toBe(0);
    remote.rotation = false; remote.fingerprint = "a".repeat(64);
    await expect(startUpload(owner, input())).rejects.toMatchObject({ code: "KEY_STATE_CHANGED" });
    await expect(startUpload(owner, { ...input(), productId: "missing" })).rejects.toMatchObject({ code: "PRODUCT_REQUIRED" });
  });
  it("coalesces creation, rejects wrong owners/oversize input and reserves global quotas", async () => {
    const spec = input(); const [a, b] = await Promise.all([startUpload(owner, spec), startUpload(owner, spec)]); expect(a.id).toBe(b.id);
    await expect(ownedUpload(a.id, "intruder")).rejects.toMatchObject({ code: "UPLOAD_NOT_FOUND" });
    await expect(startUpload(owner, { ...input(), bytes: MAX_SOURCE_BYTES + 1 })).rejects.toMatchObject({ code: "INVALID_UPLOAD" });
    vi.stubEnv("VIDEO_MAX_PENDING_JOBS", "1"); await expect(startUpload(owner, input())).rejects.toMatchObject({ code: "JOB_QUOTA" });
    vi.stubEnv("VIDEO_MAX_STORAGE_BYTES", String(MAX_SOURCE_BYTES)); await expect(startUpload(owner, input())).rejects.toMatchObject({ code: "STORAGE_QUOTA" });
    expect(JSON.stringify(uploadView(a))).not.toContain(a.version.wrappedRootKey);
  });
  it("recovers an object persisted before its database acknowledgement, with immutable checksum checks", async () => {
    const u = await startUpload(owner, input()); const key = unwrapDek(u.version.wrappedRootKey);
    const encrypted = sealObject(key, { asset: u.version.assetId, version: u.versionId, attempt: u.id, name: sourceName(0) }, source);
    await storage.put(`${u.version.storagePrefix}/source/${sourceName(0)}`, Readable.from([encrypted]), encrypted.length);
    expect((await ownedUpload(u.id, owner)).receivedBytes).toBe(BigInt(0));
    await receivePart(u.id, owner, 0, sha256(source), Readable.from([source]), storage);
    const duplicate = await receivePart(u.id, owner, 0, sha256(source), Readable.from([source]), storage); expect(duplicate.receivedBytes).toBe(BigInt(source.length));
    const altered = Buffer.from(source); altered[100] ^= 1;
    await expect(receivePart(u.id, owner, 0, sha256(altered), Readable.from([altered]), storage)).rejects.toMatchObject({ code: "UPLOAD_CONFLICT" });
    expect(await readSourcePart(storage, u, 0, key)).toEqual(source); key.fill(0);
  });
  it("bounds bodies, checks hashes and leaves the offset unchanged on interruption", async () => {
    const u = await startUpload(owner, input());
    await expect(receivePart(u.id, owner, 0, "a".repeat(64), Readable.from([source]), storage)).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    await expect(receivePart(u.id, owner, 0, sha256(source), Readable.from([source, Buffer.from("extra")]), storage)).rejects.toMatchObject({ code: "INVALID_UPLOAD" });
    await expect(receivePart(u.id, owner, 0, sha256(source), Readable.from([source.subarray(0, 50)]), storage)).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect((await ownedUpload(u.id, owner)).receivedBytes).toBe(BigInt(0));
    await expect(completeUpload(u.id, owner)).rejects.toMatchObject({ code: "UPLOAD_CONFLICT" });
  });
  it("retains encrypted parts during rotation, then resumes once the existing DEK is rewrapped", async () => {
    const u = await startUpload(owner, input()); await receivePart(u.id, owner, 0, sha256(source), Readable.from([source]), storage);
    remote.rotation = true; await expect(completeUpload(u.id, owner)).rejects.toMatchObject({ code: "ROTATION_PENDING" });
    remote.rotation = false;
    const replacement = randomBytes(32); remote.key = replacement.toString("base64url"); remote.fingerprint = sha256(remote.key);
    const product = await prisma.product.update({ where: { id: productId }, data: { keyFingerprint: remote.fingerprint } });
    const envelope = await prisma.mediaEnvelope.findUniqueOrThrow({ where: { mediaId } }); const dek = unwrapDek(envelope.wrappedDek!);
    await prisma.mediaProduct.update({ where: { productId_mediaId: { productId, mediaId } }, data: {
      keyFingerprint: remote.fingerprint, encryptedDek: encryptSourceUrl(dek.toString("base64url"), remote.key, product.satsrailProductId) } }); dek.fill(0);
    await expect(completeUpload(u.id, owner)).rejects.toMatchObject({ code: "KEY_STATE_CHANGED" });
    expect((await resumeUpload(u.id, owner)).receivedBytes).toBe(BigInt(source.length));
    const done = await completeUpload(u.id, owner); expect(done.version.status).toBe("queued");
    expect((await completeUpload(u.id, owner)).id).toBe(done.id);
  });
  it("rejects malformed input and excessive duration without publishing", async () => {
    const malformed = Buffer.alloc(100); source.copy(malformed, 0, 0, 32);
    const u = await uploadSource(malformed), config = videoConfig();
    await runNextJob(storage, 15, undefined, storageIdentity(config), config);
    expect((await ownedUpload(u.id, owner)).version.job?.lastErrorCode).toBe("INVALID_VIDEO");
    expect((await ownedUpload(u.id, owner)).version.asset.publishedVersionId).toBeNull();
    const valid = await uploadSource(); vi.stubEnv("VIDEO_MAX_DURATION_SECONDS", "1");
    await runNextJob(storage, 15, undefined, storageIdentity(config), config);
    expect((await ownedUpload(valid.id, owner)).version.job?.lastErrorCode).toBe("INVALID_VIDEO");
  });
  it("fences cancellation, tampered output and changed access before publication", async () => {
    const original = await uploadSource(), config = videoConfig();
    await runNextJob(storage, 15, undefined, storageIdentity(config), config);
    expect((await ownedUpload(original.id, owner)).version.status).toBe("ready");
    for (const mode of ["cancel", "tamper", "association"] as const) {
      const u = await uploadSource(); let applied = false;
      const put = storage.put.bind(storage);
      const spy = vi.spyOn(storage, "put").mockImplementation(async (key, body, bytes) => {
        if (!applied && key.includes("/attempts/") && key.endsWith(".m4s")) {
          applied = true;
          if (mode === "cancel") await abortUpload(u.id, owner);
          if (mode === "association") await prisma.product.update({ where: { id: productId }, data: { productStatus: "archived" } });
          if (mode === "tamper") { const chunks = []; for await (const chunk of body) chunks.push(chunk); const data = Buffer.concat(chunks); data[data.length - 1] ^= 1; return put(key, Readable.from([data]), bytes); }
        }
        return put(key, body, bytes);
      });
      try { await runNextJob(storage, 15, undefined, storageIdentity(config), config); } finally { spy.mockRestore(); }
      expect(applied).toBe(true);
      const done = await ownedUpload(u.id, owner); expect(done.version.status).not.toBe("ready"); expect(done.version.encryptedDescriptor).toBeNull();
      expect(done.version.asset.publishedVersionId).toBe(original.versionId);
      await prisma.product.update({ where: { id: productId }, data: { productStatus: "active" } });
    }
  });
  it("supports a seekable authenticated source bridge and rejects other paths", async () => {
    const u = await uploadSource(); const job = (await claimJob(["package_asset"], 15, storageIdentity(videoConfig())))!;
    const bridge = await privateMediaBridge(u, job, storage, new AbortController().signal);
    try {
      const result = await fetch(bridge.sourceUrl, { headers: { range: "bytes=123-1000" } }); expect(result.status).toBe(206);
      expect(Buffer.from(await result.arrayBuffer())).toEqual(source.subarray(123, 1001));
      expect((await fetch(bridge.sourceUrl.replace(/\/[a-f0-9]{64}\//, "/wrong/"))).status).toBe(403);
      expect((await fetch(bridge.sourceUrl, { headers: { range: "bytes=9999999999-" } })).status).toBe(416);
    } finally { await bridge.close(); }
  });
  for (const segment of [4, 10] as const) it(`encodes, authenticates and atomically publishes a real ${segment}s-segment movie`, async () => {
    const legacy = await prisma.mediaEnvelope.findUniqueOrThrow({ where: { mediaId } });
    const u = await uploadSource(source, segment), config = videoConfig();
    await packageVideo((await claimJob(["package_asset"], 15, storageIdentity(config)))!, storage, new AbortController().signal, config);
    const completed = await ownedUpload(u.id, owner);
    expect(completed.version.job?.lastErrorCode).toBeNull(); expect(completed.version.status).toBe("ready");
    expect(completed.version.asset.publishedVersionId).toBe(u.versionId);
    expect((await prisma.mediaEnvelope.findUniqueOrThrow({ where: { mediaId } })).bytes).toEqual(legacy.bytes);
    const bytes = Buffer.from(completed.version.encryptedDescriptor!), mediaKey = unwrapDek(legacy.wrappedDek!);
    const decipher = createDecipheriv("aes-256-gcm", mediaKey, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(JSON.stringify(["privapaid-video-descriptor", 1, u.version.assetId, u.versionId]))); decipher.setAuthTag(bytes.subarray(-16));
    const descriptor = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString()); mediaKey.fill(0);
    const stream = await storage.read(completed.version.manifestKey!); const parts = []; for await (const p of stream) parts.push(p);
    const manifest = openObject(Buffer.from(descriptor.rootKey, "base64url"), { asset: descriptor.asset, version: descriptor.version, attempt: descriptor.attempt, name: "play.mpd" }, Buffer.concat(parts));
    expect(manifest.toString()).toContain('type="static"');
    for (const object of (await storage.list(u.version.storagePrefix, 100)).objects) {
      const prefix = await storage.read(object.key, { start: 0, end: 3 }); const chunks = []; for await (const c of prefix) chunks.push(c);
      expect(Buffer.concat(chunks).toString()).toBe("PPV1");
    }
  });
  it("cancels queued processing and expires retained failed staging", async () => {
    const u = await uploadSource(); await abortUpload(u.id, owner);
    expect(await runNextJob(storage, 15, undefined, storageIdentity(videoConfig()), videoConfig())).toBe(false);
    await prisma.$executeRaw`UPDATE "VideoAssetVersion" SET "updatedAt" = clock_timestamp() - interval '2 days' WHERE id = ${u.versionId}::uuid`;
    expect(await cleanupStaging(storage, videoConfig())).toBe(true);
    expect((await storage.list(u.version.storagePrefix, 100)).objects).toHaveLength(0);
    expect((await ownedUpload(u.id, owner)).version.reservedBytes).toBe(BigInt(0));
  });
  it("requires fresh product validation on retry and reserves another output attempt", async () => {
    const u = await uploadSource(); const job = (await claimJob(["package_asset"], 15))!;
    await failJob(job, "KEY_STATE_CHANGED", true);
    remote.rotation = true; await expect(retryUpload(u.id, owner)).rejects.toMatchObject({ code: "ROTATION_PENDING" });
    remote.rotation = false; const retried = await retryUpload(u.id, owner);
    expect(retried.version.status).toBe("queued"); expect(retried.version.reservedBytes).toBeGreaterThan(u.version.reservedBytes);
    remote.unavailable = true; await expect(verifyProductBinding(mediaId, productId)).rejects.toBeInstanceOf(IngestionError);
  });
});
