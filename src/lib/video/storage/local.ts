import { constants } from "node:fs";
import { mkdir, mkdtemp, writeFile, readFile, rename, rm, readdir, lstat, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StorageError, validateKey, validateRange, validateBytes, validateParts, validatePart, validateList, type VideoStorage, type ObjectInfo, type Part, type ByteRange } from "./types";

const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const errorCode = (err: unknown) => (err as NodeJS.ErrnoException).code;
export class LocalVideoStorage implements VideoStorage {
  constructor(private readonly root: string) {}
  private dir(key: string) { validateKey(key); return path.join(this.root, "objects", hash(key)); }
  private async safeDir(dir: string) {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageError("INVALID");
  }
  async check() {
    for (const dir of [this.root, path.join(this.root, "objects"), path.join(this.root, "multipart"), path.join(this.root, "tmp")]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await this.safeDir(dir);
    }
    const dir = await mkdtemp(path.join(this.root, "tmp", "check-"));
    await rm(dir, { recursive: true });
  }
  async put(key: string, body: Readable, bytes: number) {
    const dest = this.dir(key); validateBytes(bytes);
    const tmp = await mkdtemp(path.join(this.root, "tmp", "put-"));
    let size = 0;
    const digest = createHash("sha256");
    try {
      const handle = await open(path.join(tmp, "data"), "wx", 0o600);
      await pipeline(body, new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > bytes) return callback(new StorageError("INVALID"));
        digest.update(chunk); callback(null, chunk);
      } }), handle.createWriteStream());
      if (size !== bytes) throw new StorageError("INVALID");
      await writeFile(path.join(tmp, "info.json"), JSON.stringify({ key, bytes, etag: digest.digest("hex") }), { mode: 0o600 });
      try { await rename(tmp, dest); }
      catch (err) { if (["EEXIST", "ENOTEMPTY"].includes(errorCode(err) || "")) throw new StorageError("CONFLICT"); throw err; }
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }
  async cleanupTemporary(olderThan: Date) {
    // Killed atomic writes can leave ciphertext in unpublished temporary dirs.
    // Request timeouts are shorter than the minimum one-hour retention window.
    const root = path.join(this.root, "tmp");
    for (const name of await readdir(root)) {
      if (!/^(?:put|check)-[A-Za-z0-9]+$/.test(name)) continue;
      const dir = path.join(root, name);
      try {
        const stat = await lstat(dir);
        if (stat.isDirectory() && !stat.isSymbolicLink() && stat.mtime < olderThan) await rm(dir, { recursive: true, force: true });
      } catch (err) { if (errorCode(err) !== "ENOENT") throw err; }
    }
  }
  async head(key: string): Promise<ObjectInfo> {
    const dir = this.dir(key);
    try {
      await this.safeDir(dir);
      const handle = await open(path.join(dir, "info.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { return JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
    } catch (err) { if (errorCode(err) === "ENOENT") throw new StorageError("NOT_FOUND"); throw err; }
  }
  async read(key: string, range?: ByteRange): Promise<Readable> {
    validateRange(range);
    const info = await this.head(key);
    if (range && range.end >= info.bytes) throw new StorageError("INVALID");
    const handle = await open(path.join(this.dir(key), "data"), constants.O_RDONLY | constants.O_NOFOLLOW);
    return handle.createReadStream(range);
  }
  async list(prefix: string, limit: number, cursor?: string) {
    validateList(prefix, limit);
    if (cursor && !/^[a-f0-9]{64}$/.test(cursor)) throw new StorageError("INVALID");
    // Local adapter is for development/small installations. S3 pagination is
    // server-side. Only one metadata record is read at a time here.
    const names = (await readdir(path.join(this.root, "objects"))).filter(n => /^[a-f0-9]{64}$/.test(n) && (!cursor || n > cursor)).sort();
    const objects: ObjectInfo[] = [];
    let last: string | undefined;
    for (const name of names) {
      const dir = path.join(this.root, "objects", name);
      try {
        await this.safeDir(dir);
        const handle = await open(path.join(dir, "info.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
        let info: ObjectInfo;
        try { info = JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
        if (!info.key.startsWith(prefix)) continue;
        if (objects.length === limit) return { objects, cursor: last };
        objects.push(info); last = name;
      } catch (err) { if (errorCode(err) !== "ENOENT") throw err; }
    }
    return { objects };
  }
  async delete(key: string) { await rm(this.dir(key), { recursive: true, force: true }); }
  private async uploadDir(key: string, id: string) {
    validateKey(key);
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new StorageError("INVALID");
    const dir = path.join(this.root, "multipart", id);
    await this.safeDir(dir);
    if (await readFile(path.join(dir, "key"), "utf8") !== key) throw new StorageError("INVALID");
    return dir;
  }
  async beginMultipart(key: string) {
    validateKey(key);
    const id = randomUUID();
    const dir = path.join(this.root, "multipart", id);
    await mkdir(dir, { mode: 0o700 });
    await writeFile(path.join(dir, "key"), key, { mode: 0o600 });
    return id;
  }
  async uploadPart(key: string, id: string, number: number, body: Buffer): Promise<Part> {
    validatePart(number, body);
    const dir = await this.uploadDir(key, id);
    const tmp = path.join(dir, randomUUID());
    await writeFile(tmp, body, { mode: 0o600 });
    const etag = createHash("sha256").update(body).digest("hex");
    await rename(tmp, path.join(dir, `${number}-${etag}`));
    return { number, etag };
  }
  async completeMultipart(key: string, id: string, parts: Part[]) {
    validateParts(parts);
    const dir = await this.uploadDir(key, id);
    let bytes = 0;
    for (const [i, part] of parts.entries()) {
      if (!/^[a-f0-9]{64}$/.test(part.etag)) throw new StorageError("INVALID");
      const stat = await lstat(path.join(dir, `${part.number}-${part.etag}`));
      if (!stat.isFile() || stat.isSymbolicLink() || (i < parts.length - 1 && stat.size < 5 * 1024 ** 2)) throw new StorageError("INVALID");
      bytes += stat.size; validateBytes(bytes);
    }
    // One part file and a bounded stream buffer at a time, including for 10k
    // parts. Content-addressed part paths keep retries from replacing input.
    async function* chunks() {
      for (const part of parts) {
        const handle = await open(path.join(dir, `${part.number}-${part.etag}`), constants.O_RDONLY | constants.O_NOFOLLOW);
        const digest = createHash("sha256");
        try {
          for await (const chunk of handle.createReadStream({ autoClose: false })) { digest.update(chunk); yield chunk; }
          if (digest.digest("hex") !== part.etag) throw new StorageError("INVALID");
        } finally { await handle.close(); }
      }
    }
    await this.put(key, Readable.from(chunks()), bytes);
    await rm(dir, { recursive: true, force: true });
  }
  async abortMultipart(key: string, id: string) {
    try { await rm(await this.uploadDir(key, id), { recursive: true, force: true }); }
    catch (err) { if (errorCode(err) !== "ENOENT") throw err; }
  }
}
