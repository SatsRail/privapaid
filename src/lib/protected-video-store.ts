import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { validateVideo } from "@/lib/protected-video-probe";
import { VideoError, videoDiagnostic } from "@/lib/protected-video-errors";
import { encryptBytes, decryptBytes } from "@/lib/content-encryption";
import { wrapDek, unwrapDek } from "@/lib/content-dek";

export const VIDEO_CHUNK_SIZE = 1024 * 1024;
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
function chunkKey(key: Buffer, id: string, index: number): Buffer {
  return createHmac("sha256", key).update(`privapaid-video-v1:${id}:${index}`).digest();
}
interface Manifest { version: 1; size: number; wrappedKey: string }
function directory(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid asset");
  const root = process.env.PRIVATE_VIDEO_DIR;
  if (!root || !path.isAbsolute(root)) throw new Error("Private video storage is not configured");
  return path.join(root, id);
}

// Raw request streaming bounds memory. Every chunk has its own random IV and
// authenticated encryption; files and the manifest never contain a raw key.
let activeUploads = 0;
export async function storeVideo(body: ReadableStream<Uint8Array>): Promise<string> {
  if (activeUploads >= 2) throw new VideoError("upload_busy");
  activeUploads++;
  try { return await storeVideoInternal(body); }
  finally { activeUploads--; }
}

async function requireDiskSpace(dir: string) {
  const disk = await statfs(dir);
  const configured = Number(process.env.PRIVATE_VIDEO_MIN_FREE_MB ?? "1024");
  const reserve = (Number.isFinite(configured) && configured >= 128 ? configured : 1024) * 1024 * 1024;
  if (disk.bavail * disk.bsize < reserve + VIDEO_CHUNK_SIZE + 28) throw new VideoError("storage_full");
}

async function storeVideoInternal(body: ReadableStream<Uint8Array>): Promise<string> {
  const id = randomUUID();
  const dir = directory(id);
  const key = randomBytes(32);
  const wrappedKey = wrapDek(key);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const reader = body.getReader();
  let size = 0, index = 0;
  let pending = Buffer.alloc(0);
  let checked = false;
  try {
    await requireDiskSpace(dir);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_VIDEO_BYTES) throw new VideoError("upload_too_large");
      pending = Buffer.concat([pending, value]);
      if (!checked && pending.length >= 12) {
        if (pending.toString("ascii", 4, 8) !== "ftyp") throw new VideoError("invalid_video");
        checked = true;
      }
      while (pending.length >= VIDEO_CHUNK_SIZE) {
        await requireDiskSpace(dir);
        await writeFile(path.join(dir, `${index}.bin`), encryptBytes(pending.subarray(0, VIDEO_CHUNK_SIZE), chunkKey(key, id, index)), { mode: 0o600, flag: "wx" });
        index++;
        pending = pending.subarray(VIDEO_CHUNK_SIZE);
      }
    }
    if (!checked) throw new VideoError("invalid_video");
    if (pending.length) await writeFile(path.join(dir, `${index}.bin`), encryptBytes(pending, chunkKey(key, id, index)), { mode: 0o600, flag: "wx" });
    const manifest: Manifest = { version: 1, size, wrappedKey };
    // Publication is last: failed validation leaves no playable asset.
    await validateVideo(videoStream(id, manifest, 0, size - 1, Date.now() + 35_000, new AbortController().signal));
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    return id;
  } catch (error) {
    await reader.cancel().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    throw error;
  } finally {
    key.fill(0);
    reader.releaseLock();
  }
}

export async function videoManifest(id: string): Promise<Manifest> {
  const manifest = JSON.parse(await readFile(path.join(directory(id), "manifest.json"), "utf8"));
  if (manifest.version !== 1 || !Number.isSafeInteger(manifest.size) || manifest.size < 12 || manifest.size > MAX_VIDEO_BYTES || typeof manifest.wrappedKey !== "string") throw new Error("Invalid manifest");
  return manifest;
}

export function videoRange(header: string | null, size: number): { start: number; end: number } | null {
  if (header === null) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) return last && last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : null;
  if (first >= size || (last !== null && last < first)) return null;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

export function videoStream(id: string, manifest: Manifest, start: number, end: number, expiresAt: number, signal: AbortSignal, onFinish: () => void = () => {}): ReadableStream<Uint8Array> {
  const key = unwrapDek(manifest.wrappedKey);
  let offset = start;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let idle: ReturnType<typeof setTimeout>;
  let abort: () => void;
  const cleanup = () => { if (stopped) return; stopped = true; onFinish(); clearTimeout(timer); clearTimeout(idle); signal.removeEventListener("abort", abort); key.fill(0); };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => { if (!stopped) { cleanup(); controller.error(new Error("Playback ended")); } };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, Math.max(0, Math.min(expiresAt - Date.now(), 2_147_483_647)));
      idle = setTimeout(abort, 60_000);
      if (signal.aborted) abort();
    },
    async pull(controller) {
      if (stopped) return;
      clearTimeout(idle);
      idle = setTimeout(abort, 60_000);
      try {
        if (Date.now() >= expiresAt) throw new Error("Playback expired");
        const index = Math.floor(offset / VIDEO_CHUNK_SIZE);
        const encrypted = await readFile(path.join(directory(id), `${index}.bin`));
        if (stopped) return;
        const plain = decryptBytes(encrypted, chunkKey(key, id, index));
        const from = offset % VIDEO_CHUNK_SIZE;
        const count = Math.min(plain.length - from, end - offset + 1);
        if (count <= 0) throw new Error("Invalid chunk");
        controller.enqueue(new Uint8Array(plain.subarray(from, from + count)));
        offset += count;
        if (offset > end) { cleanup(); controller.close(); }
      } catch { if (!stopped) { videoDiagnostic("stream_failed"); cleanup(); controller.error(new Error("Playback unavailable")); } }
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 0 });
}
