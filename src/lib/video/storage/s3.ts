import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { StorageError, validateKey, validateRange, validateBytes, validateParts, validatePart, validateList, type VideoStorage, type Part, type ByteRange } from "./types";

export class S3VideoStorage implements VideoStorage {
  constructor(private readonly client: S3Client, private readonly bucket: string, private readonly prefix: string) {}
  private key(key: string) { validateKey(key); return this.prefix + key; }
  private async call<T>(request: () => Promise<T>): Promise<T> {
    try { return await request(); }
    catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) throw new StorageError("NOT_FOUND");
      if (status === 409 || status === 412) throw new StorageError("CONFLICT");
      if (err instanceof StorageError) throw err;
      throw new StorageError("UNAVAILABLE");
    }
  }
  async check() { await this.call(() => this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix, MaxKeys: 1 }))); }
  async put(key: string, body: Readable, bytes: number) {
    validateBytes(bytes);
    await this.call(() => this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(key), Body: body, ContentLength: bytes, ContentType: "application/octet-stream", IfNoneMatch: "*" })));
  }
  async head(key: string) {
    const r = await this.call(() => this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) })));
    return { key, bytes: r.ContentLength!, etag: r.ETag! };
  }
  async read(key: string, range?: ByteRange): Promise<Readable> {
    validateRange(range);
    if (range && range.end >= (await this.head(key)).bytes) throw new StorageError("INVALID");
    const r = await this.call(() => this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key), Range: range ? `bytes=${range.start}-${range.end}` : undefined })));
    if (!r.Body) throw new StorageError("NOT_FOUND");
    return r.Body as Readable;
  }
  async list(prefix: string, limit: number, cursor?: string) {
    validateList(prefix, limit);
    if (cursor && cursor.length > 4096) throw new StorageError("INVALID");
    const r = await this.call(() => this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix + prefix, MaxKeys: limit, ContinuationToken: cursor })));
    return { objects: (r.Contents || []).map(o => ({ key: o.Key!.slice(this.prefix.length), bytes: o.Size!, etag: o.ETag! })), cursor: r.NextContinuationToken };
  }
  async delete(key: string) { await this.call(() => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }))); }
  async beginMultipart(key: string) {
    const r = await this.call(() => this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: this.key(key), ContentType: "application/octet-stream" })));
    if (!r.UploadId) throw new StorageError("UNAVAILABLE");
    return r.UploadId;
  }
  async uploadPart(key: string, id: string, number: number, body: Buffer): Promise<Part> {
    validatePart(number, body);
    const r = await this.call(() => this.client.send(new UploadPartCommand({ Bucket: this.bucket, Key: this.key(key), UploadId: id, PartNumber: number, Body: body, ContentLength: body.length })));
    if (!r.ETag) throw new StorageError("UNAVAILABLE");
    return { number, etag: r.ETag };
  }
  async completeMultipart(key: string, id: string, parts: Part[]) {
    validateParts(parts);
    await this.call(() => this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: this.key(key), UploadId: id, IfNoneMatch: "*", MultipartUpload: { Parts: parts.map(p => ({ PartNumber: p.number, ETag: p.etag })) } })));
  }
  async abortMultipart(key: string, id: string) {
    try { await this.call(() => this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: this.key(key), UploadId: id }))); }
    catch (err) { if (!(err instanceof StorageError && err.code === "NOT_FOUND")) throw err; }
  }
}
