import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { encryptBytes, decryptBytes } from "@/lib/content-encryption";
import { attemptPrefix, claimJob, completeJob, failJob, heartbeat, LeaseLostError, type JobErrorCode, type Lease } from "./jobs";
import { packageVideo } from "./package-job";
import { ingestionConfig } from "./ingestion-config";
import { IngestionError } from "./ingestion-errors";
import type { VideoConfig } from "./config";
import type { VideoStorage } from "./storage/types";

class JobFailure extends Error { constructor(readonly code: JobErrorCode) { super(code); } }
async function storageProbe(storage: VideoStorage, job: Lease) {
  const key = randomBytes(32);
  const plaintext = randomBytes(1024);
  const objectKey = `${attemptPrefix(job)}/probe.bin`;
  let written = false;
  try {
    const encrypted = encryptBytes(plaintext, key);
    await storage.put(objectKey, Readable.from([encrypted]), encrypted.length); written = true;
    const info = await storage.head(objectKey);
    if (info.bytes !== encrypted.length) throw new JobFailure("PROBE_MISMATCH");
    const stream = await storage.read(objectKey);
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > encrypted.length) { stream.destroy(); throw new JobFailure("PROBE_MISMATCH"); }
      chunks.push(Buffer.from(chunk));
    }
    if (!decryptBytes(Buffer.concat(chunks), key).equals(plaintext)) throw new JobFailure("PROBE_MISMATCH");
  } finally {
    key.fill(0); plaintext.fill(0);
    if (written) await storage.delete(objectKey);
  }
}
export async function runNextJob(storage: VideoStorage, leaseSeconds: number, signal?: AbortSignal, scope?: string, config?: VideoConfig): Promise<boolean> {
  const job = await claimJob(config ? ["storage_probe", "package_asset"] : ["storage_probe"], leaseSeconds, scope);
  if (!job) return false;
  const stop = new AbortController();
  const abort = () => stop.abort(new JobFailure("WORKER_STOPPED"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let beating = false;
  const beat = setInterval(async () => {
    if (beating) return;
    beating = true;
    try { await heartbeat(job, leaseSeconds); } catch { stop.abort(new LeaseLostError()); }
    finally { beating = false; }
  }, Math.floor(leaseSeconds * 1000 / 3));
  const timeout = setTimeout(() => stop.abort(new JobFailure("JOB_TIMEOUT")),
    job.kind === "package_asset" ? ingestionConfig().jobTimeoutSeconds * 1000 : 120_000);
  try {
    stop.signal.throwIfAborted();
    if (job.kind === "package_asset") await packageVideo(job, storage, stop.signal, config!);
    else { await storageProbe(storage, job); stop.signal.throwIfAborted(); await completeJob(job); }
  } catch (error) {
    const err = stop.signal.aborted ? stop.signal.reason : error;
    if (!(err instanceof LeaseLostError)) {
      try {
        const code = err instanceof IngestionError || err instanceof JobFailure ? err.code : "STORAGE_UNAVAILABLE";
        await failJob(job, code, err instanceof IngestionError && !err.retryable);
      } catch (failure) { if (!(failure instanceof LeaseLostError)) throw failure; }
    }
  } finally {
    clearInterval(beat); clearTimeout(timeout); signal?.removeEventListener("abort", abort);
  }
  return true;
}
