import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { unwrapDek } from "@/lib/content-dek";
import { IngestionError } from "./ingestion-errors";
import { MAX_OBJECT_BYTES, MAX_OBJECTS, OUTPUT_BUDGET } from "./ingestion-config";
import { sha256, sealObject, openObject, type ObjectIdentity } from "./format";
import { boundedBytes, objectBytes } from "./streams";
import { readSourcePart, type Upload } from "./uploads";
import { attemptPrefix, type Lease } from "./jobs";
import type { VideoStorage } from "./storage/types";
export type OutputObject = { name: string; bytes: number; encryptedBytes: number; sha256: string; encryptedSha256: string };
export async function privateMediaBridge(upload: Upload, job: Lease, storage: VideoStorage, signal: AbortSignal) {
  const root = unwrapDek(upload.version.wrappedRootKey), token = randomBytes(32).toString("hex");
  const prefix = attemptPrefix(job, upload.version.storagePrefix);
  const objects = new Map<string, OutputObject>();
  const pending = new Set<Promise<void>>();
  let manifest: Buffer | undefined, failure: unknown, active = 0, written = 0, writing = 0, port = 0;
  const identity = (name: string): ObjectIdentity => ({ asset: upload.version.assetId, version: upload.versionId, attempt: job.leaseToken, name });
  async function persist(name: string, plain: Buffer) {
    const digest = sha256(plain), existing = objects.get(name);
    if (existing) { if (existing.sha256 !== digest) throw new IngestionError("OUTPUT_INVALID"); return existing; }
    if (objects.size + writing >= MAX_OBJECTS || written + plain.length + 32 > OUTPUT_BUDGET) throw new IngestionError("OUTPUT_INVALID");
    const encrypted = sealObject(root, identity(name), plain);
    signal.throwIfAborted();
    written += encrypted.length; writing++;
    try { await storage.put(`${prefix}/${name}`, Readable.from([encrypted]), encrypted.length); }
    catch (err) { written -= encrypted.length; throw err; }
    finally { writing--; }
    const record = { name, bytes: plain.length, encryptedBytes: encrypted.length, sha256: digest, encryptedSha256: sha256(encrypted) };
    objects.set(name, record);
    return record;
  }
  const server = createServer((req, res) => {
    const handle = (async () => {
      if (signal.aborted || active >= 8 || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin || !req.url?.startsWith(`/${token}/`)) { res.writeHead(403).end(); return; }
      active++;
      try {
        res.setHeader("Cache-Control", "no-store");
        if (req.url === `/${token}/source.mp4` && ["GET", "HEAD"].includes(req.method || "")) {
          const size = Number(upload.expectedBytes);
          let start = 0, end = size - 1;
          if (req.headers.range) {
            const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
            if (!match) { res.writeHead(416).end(); return; }
            start = Number(match[1]); end = match[2] ? Number(match[2]) : end;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) { res.writeHead(416).end(); return; }
            end = Math.min(end, size - 1); res.statusCode = 206;
            res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
          }
          res.setHeader("Content-Type", "video/mp4"); res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Content-Length", end - start + 1);
          if (req.method === "HEAD") { res.end(); return; }
          for (let index = Math.floor(start / upload.partBytes); index <= Math.floor(end / upload.partBytes); index++) {
            if (res.destroyed) return; signal.throwIfAborted();
            const plain = await readSourcePart(storage, upload, index, root, signal);
            try {
              const partStart = index * upload.partBytes;
              await new Promise<void>((resolve, reject) => res.write(plain.subarray(Math.max(0, start - partStart), Math.min(plain.length, end - partStart + 1)), error => error ? reject(error) : resolve()));
            } finally { plain.fill(0); }
          }
          res.end(); return;
        }
        const name = req.url.slice(`/${token}/output/`.length);
        if (req.method !== "PUT" || !req.url.startsWith(`/${token}/output/`) || !/^(?:play\.mpd|init-\d{1,3}\.mp4|segment-\d{1,3}-\d{5,8}\.m4s)$/.test(name)) { res.writeHead(404).end(); return; }
        const bytes = await boundedBytes(req, name === "play.mpd" ? 2 * 1024 ** 2 : MAX_OBJECT_BYTES, signal);
        if (name === "play.mpd") { manifest?.fill(0); manifest = bytes; }
        else { try { await persist(name, bytes); } finally { bytes.fill(0); } }
        res.writeHead(200).end();
      } catch (err) {
        // A demuxer closing a range early during a seek is normal.
        const sourceClosed = req.method !== "PUT" && (res.destroyed || ["EPIPE", "ECONNRESET", "ECANCELED", "ERR_STREAM_DESTROYED"].includes((err as NodeJS.ErrnoException).code || ""));
        if (!sourceClosed && !signal.aborted) failure ||= err;
        if (!res.headersSent) res.writeHead(500);
        res.destroy();
      } finally { active--; }
    })();
    pending.add(handle); void handle.finally(() => pending.delete(handle));
  });
  server.requestTimeout = 60000; server.headersTimeout = 10000; server.timeout = 60000;
  const abort = () => server.closeAllConnections(); signal.addEventListener("abort", abort, { once: true });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  port = (server.address() as { port: number }).port;
  return {
    sourceUrl: `http://127.0.0.1:${port}/${token}/source.mp4`, outputUrl: `http://127.0.0.1:${port}/${token}/output/play.mpd`, prefix, objects, identity,
    async read(record: OutputObject) {
      const encrypted = await objectBytes(await storage.read(`${prefix}/${record.name}`), record.encryptedBytes, signal);
      if (encrypted.length !== record.encryptedBytes || sha256(encrypted) !== record.encryptedSha256) throw new IngestionError("OUTPUT_INVALID");
      const plain = openObject(root, identity(record.name), encrypted);
      if (sha256(plain) !== record.sha256) { plain.fill(0); throw new IngestionError("OUTPUT_INVALID"); }
      return plain;
    },
    async finish() {
      await Promise.all(pending); if (failure) throw failure;
      if (!manifest || !objects.size) throw new IngestionError("OUTPUT_INVALID");
      return Buffer.from(manifest);
    },
    persist,
    async close() {
      signal.removeEventListener("abort", abort); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve())); await Promise.allSettled(pending);
      manifest?.fill(0); root.fill(0);
    },
  };
}
export type MediaBridge = Awaited<ReturnType<typeof privateMediaBridge>>;
