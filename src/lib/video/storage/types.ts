import type { Readable } from "node:stream";

// Callers supply ciphertext only. This layer neither encrypts nor issues access
// grants. Lengths describe encrypted bytes; ETags are opaque transport tokens.
export type ObjectInfo = { key: string; bytes: number; etag: string };
export type Part = { number: number; etag: string };
export type ByteRange = { start: number; end: number }; // inclusive, single range
export interface VideoStorage {
  check(): Promise<void>;
  cleanupTemporary?(olderThan: Date): Promise<void>;
  put(key: string, body: Readable, bytes: number): Promise<void>;
  head(key: string): Promise<ObjectInfo>;
  read(key: string, range?: ByteRange): Promise<Readable>;
  list(prefix: string, limit: number, cursor?: string): Promise<{ objects: ObjectInfo[]; cursor?: string }>;
  delete(key: string): Promise<void>;
  beginMultipart(key: string): Promise<string>;
  uploadPart(key: string, uploadId: string, number: number, body: Buffer): Promise<Part>;
  completeMultipart(key: string, uploadId: string, parts: Part[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}
// A future delivery adapter can mint CDN grants. It cannot fetch SatsRail keys,
// and a storage URL/grant is never a payment macaroon or decryption key.
export interface DeliveryGrantIssuer {
  issue(input: { prefix: string; expiresAt: Date }): Promise<{ url: string; expiresAt: Date }>;
}
export class StorageError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID" | "UNAVAILABLE") { super(code); }
}
export function validateKey(key: string): void {
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(key) || key.length > 512 ||
      key.split("/").some(p => p === "." || p === "..")) throw new StorageError("INVALID");
}
export function validateRange(range?: ByteRange): void {
  if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start)) throw new StorageError("INVALID");
}
export function validateBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 10 * 1024 ** 3) throw new StorageError("INVALID");
}
export function validateParts(parts: Part[]): void {
  if (!parts.length || parts.length > 10000 || parts.some((p, i) => p.number !== i + 1 || !p.etag || p.etag.length > 256)) throw new StorageError("INVALID");
}
export function validatePart(number: number, body: Buffer): void {
  if (!Number.isInteger(number) || number < 1 || number > 10000 || !body.length || body.length > 64 * 1024 ** 2) throw new StorageError("INVALID");
}
export function validateList(prefix: string, limit: number): void {
  if (prefix) validateKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new StorageError("INVALID");
}
