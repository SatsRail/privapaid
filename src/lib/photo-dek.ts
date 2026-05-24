/**
 * KEK-based wrapping for per-photo DEKs.
 *
 * Photos are stored ciphertext-at-rest in GridFS under a random 32-byte DEK
 * (data encryption key). The DEK is then wrapped — historically only under
 * each SatsRail product key (envelope encryption), which forced a SatsRail
 * round-trip every time we needed to create a new product covering a photo
 * and made the "decrypt with an existing product to recover the DEK" step
 * a single point of failure (no existing product → can't create another).
 *
 * This module persists a second copy of the wrapped DEK on the Media doc
 * itself, wrapped under an operator-held KEK (key encryption key) from the
 * PHOTO_KEK env var. Creating new products becomes a single-step operation
 * with no SatsRail round-trip for the DEK, and "photo has no MediaProduct
 * yet" stops being a blocker.
 *
 * Threat model: a database-only snapshot leak still does NOT expose photo
 * content, because the KEK lives in the operator's environment, not the
 * database. If the operator's infrastructure is compromised end-to-end
 * (DB + env), photos are exposed — but at that point the merchant API key
 * is also compromised, so the previous wrap-only-under-product-key model
 * gave no additional protection either.
 */

import { encryptBytes, decryptBytes } from "@/lib/content-encryption";

const KEK_LENGTH = 32;
const DEK_LENGTH = 32;

let cachedKek: Buffer | null = null;

/**
 * Load and validate the PHOTO_KEK from the environment.
 *
 * Accepts both standard Base64 and URL-safe Base64. Caches after first read
 * — the env doesn't change at runtime.
 *
 * Throws if PHOTO_KEK is missing or doesn't decode to exactly 32 bytes.
 * Generate one with: `openssl rand -base64 32`
 */
function loadKek(): Buffer {
  if (cachedKek) return cachedKek;
  const raw = process.env.PHOTO_KEK;
  if (!raw) {
    throw new Error(
      "PHOTO_KEK is not set. Generate one with `openssl rand -base64 32` and add it to .env.local / your secrets store."
    );
  }
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const buf = Buffer.from(normalized, "base64");
  if (buf.length !== KEK_LENGTH) {
    throw new Error(
      `PHOTO_KEK must decode to ${KEK_LENGTH} bytes (got ${buf.length}). Regenerate with \`openssl rand -base64 32\`.`
    );
  }
  cachedKek = buf;
  return cachedKek;
}

/** Internal: only exposed for tests. Resets the cached KEK. */
export function _resetKekCache(): void {
  cachedKek = null;
}

/**
 * Wrap a raw 32-byte DEK under the operator's KEK.
 *
 * Returns a Base64 string suitable for storage in MongoDB. The output format
 * is the same envelope layout as encryptBytes (`IV[12] || ct || tag[16]`),
 * just Base64-encoded for safe text storage.
 */
export function wrapDek(dekBytes: Buffer | Uint8Array): string {
  const buf = Buffer.from(dekBytes);
  if (buf.length !== DEK_LENGTH) {
    throw new Error(`DEK must be ${DEK_LENGTH} bytes, got ${buf.length}`);
  }
  const kek = loadKek();
  return encryptBytes(buf, kek).toString("base64");
}

/**
 * Unwrap a KEK-wrapped DEK back to its raw 32 bytes.
 *
 * Throws on auth-tag mismatch (tampering) or when the wrapped value is
 * unreadable. Callers should treat any throw as "this DEK is unrecoverable
 * via the KEK" and either fall back to a different recovery path or surface
 * the failure.
 */
export function unwrapDek(wrapped: string): Buffer {
  const kek = loadKek();
  const blob = Buffer.from(wrapped, "base64");
  const out = decryptBytes(blob, kek);
  if (out.length !== DEK_LENGTH) {
    throw new Error(`Unwrapped DEK has unexpected length ${out.length}`);
  }
  return out;
}

/**
 * Convenience: take the Base64url DEK as returned by /api/admin/photos and
 * wrap it under the KEK. Mirrors the on-the-wire format the upload route
 * already returns to the client.
 */
export function wrapDekFromBase64url(dekBase64url: string): string {
  const normalized = dekBase64url.replace(/-/g, "+").replace(/_/g, "/");
  const dekBytes = Buffer.from(normalized, "base64");
  return wrapDek(dekBytes);
}

/**
 * Convenience: unwrap to the Base64url string format expected by
 * `encryptSourceUrl` when wrapping a DEK for a product key.
 */
export function unwrapDekToBase64url(wrapped: string): string {
  return unwrapDek(wrapped)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
