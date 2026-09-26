import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, mkdir, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { LocalVideoStorage } from "@/lib/video/storage/local";
import { S3VideoStorage } from "@/lib/video/storage/s3";
import type { VideoStorage } from "@/lib/video/storage/types";
import { s3ProtocolServer } from "../../helpers/video-s3-server";
async function bytes(stream: Readable) { const parts = []; for await (const p of stream) parts.push(Buffer.from(p)); return Buffer.concat(parts); }
for (const provider of ["local", "s3"] as const) {
  describe(`${provider} storage contract`, () => {
    let storage: VideoStorage, root: string, server: Awaited<ReturnType<typeof s3ProtocolServer>>, client: S3Client;
    beforeAll(async () => {
      if (provider === "local") { root = await mkdtemp(path.join(tmpdir(), "ppv-storage-")); storage = new LocalVideoStorage(root); }
      else {
        server = await s3ProtocolServer();
        client = new S3Client({ region: "us-east-1", endpoint: server.endpoint, forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" }, maxAttempts: 1 });
        storage = new S3VideoStorage(client, "bucket", "private/");
      }
      await storage.check();
    });
    afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); if (server) { client.destroy(); await server.close(); } });
    if (provider === "local") it("cleans only expired atomic-write temporary directories", async () => {
      const old = await mkdtemp(path.join(root, "tmp", "put-")), fresh = await mkdtemp(path.join(root, "tmp", "put-"));
      const unrelated = path.join(root, "tmp", "keep-me"); await mkdir(unrelated);
      const past = new Date(Date.now() - 2 * 86400_000); await utimes(old, past, past); await utimes(unrelated, past, past);
      await storage.cleanupTemporary!(new Date(Date.now() - 86400_000));
      const remaining = await readdir(path.join(root, "tmp")); expect(remaining).not.toContain(path.basename(old));
      expect(remaining).toContain(path.basename(fresh)); expect(remaining).toContain("keep-me");
    });
    it("round-trips opaque bytes, ranges and metadata, with immutable publication", async () => {
      const key = `assets/${randomUUID()}/one.bin`, data = Buffer.from("opaque encrypted bytes");
      await storage.put(key, Readable.from([data]), data.length);
      expect((await storage.head(key)).bytes).toBe(data.length);
      expect(await bytes(await storage.read(key))).toEqual(data);
      expect(await bytes(await storage.read(key, { start: 2, end: 8 }))).toEqual(data.subarray(2, 9));
      await expect(storage.put(key, Readable.from([data]), data.length)).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(storage.read(key, { start: 0, end: data.length })).rejects.toMatchObject({ code: "INVALID" });
      await storage.delete(key); await storage.delete(key);
      await expect(storage.head(key)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    it("has exactly one winner for concurrent writes to the same key", async () => {
      const key = `assets/${randomUUID()}/same.bin`;
      const result = await Promise.allSettled(["first", "other"].map(v => storage.put(key, Readable.from([v]), 5)));
      expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(["first", "other"]).toContain((await bytes(await storage.read(key))).toString());
    });
    it("paginates without duplicate or unrelated keys", async () => {
      const prefix = `assets/${randomUUID()}`;
      for (let i = 0; i < 5; i++) await storage.put(`${prefix}/${i}.bin`, Readable.from(["x"]), 1);
      const found: string[] = []; let cursor: string | undefined;
      do { const page = await storage.list(prefix + "/", 2, cursor); found.push(...page.objects.map(o => o.key)); cursor = page.cursor; } while (cursor);
      expect(new Set(found).size).toBe(5); expect(found.every(k => k.startsWith(prefix))).toBe(true);
    });
    it("completes and aborts multipart uploads without overwriting published bytes", async () => {
      const key = `assets/${randomUUID()}/multipart.bin`;
      const id = await storage.beginMultipart(key);
      const first = Buffer.alloc(5 * 1024 ** 2, 7), last = Buffer.from("tail");
      const parts = [await storage.uploadPart(key, id, 1, first), await storage.uploadPart(key, id, 2, last)];
      await storage.completeMultipart(key, id, parts);
      expect(await bytes(await storage.read(key))).toEqual(Buffer.concat([first, last]));
      const retry = await storage.beginMultipart(key);
      const part = await storage.uploadPart(key, retry, 1, last);
      await expect(storage.completeMultipart(key, retry, [part])).rejects.toMatchObject({ code: "CONFLICT" });
      await storage.abortMultipart(key, retry); await storage.abortMultipart(key, retry);
      if (server) expect(server.requests.filter(r => r.method === "POST" && r.path.includes("uploadId=")).every(r => r.conditional === "*")).toBe(true);
    });
    it("rejects path traversal, malformed ranges and invalid multipart order", async () => {
      for (const key of ["../secret", "/tmp/file", "a/../../b", "https://bucket/key", "a\\b"]) await expect(storage.head(key)).rejects.toMatchObject({ code: "INVALID" });
      await expect(storage.read("safe/key", { start: -1, end: 3 })).rejects.toMatchObject({ code: "INVALID" });
      await expect(storage.completeMultipart("safe/key", "id", [{ number: 2, etag: "e" }])).rejects.toMatchObject({ code: "INVALID" });
    });
    if (provider === "local") {
      it("does not publish partial writes or follow object-directory symlinks", async () => {
        const key = `assets/${randomUUID()}/bad.bin`;
        await expect(storage.put(key, Readable.from(["short"]), 9)).rejects.toMatchObject({ code: "INVALID" });
        await expect(storage.head(key)).rejects.toMatchObject({ code: "NOT_FOUND" });
        const target = path.join(root, "external"); await mkdir(target);
        await symlink(target, path.join(root, "objects", createHash("sha256").update(key).digest("hex")));
        await expect(storage.head(key)).rejects.toMatchObject({ code: "INVALID" });
      });
    }
  });
}
