/**
 * Shared Web Crypto helpers for decryption tests.
 *
 * The browser-side decryption code in `src/lib/client-crypto.ts` uses
 * `crypto.subtle` directly. Tests need a Node-compatible mirror so they
 * can verify what the browser will do without spinning up a real one.
 *
 * Every helper here MUST stay byte-compatible with its `client-crypto.ts`
 * counterpart. If the client contract drifts, update both sides.
 *
 * Centralized so the four+ test files that exercise the end-to-end
 * decryption path don't each redefine the same Web Crypto plumbing —
 * one source of truth means a contract change is one edit, not four.
 */

import { randomBytes, webcrypto } from "crypto";
import { createEnvelopeArtifacts, URL_ENVELOPE_MIME } from "@/lib/media-envelope";

// ── MediaEnvelope nested-create helpers ───────────────────────────────
//
// Media.blob was dropped; every Media now owns one MediaEnvelope holding its
// encrypted payload. Tests that build a Media directly via `prisma.media.create`
// (rather than the `createMedia` factory) use these to mint the paired envelope
// inline, replacing the old `blob: { kind: "url", url }` literal.

/**
 * Build a nested `envelope: { create: {...} }` input for a Media that carries
 * `payload` (URL string bytes for url-media, content bytes for photo/article).
 * Pass `mimeType` for non-url payloads; defaults to the url-envelope MIME.
 */
export function envelopeCreateForPayload(
  payload: Buffer | Uint8Array | string,
  mimeType: string = URL_ENVELOPE_MIME
) {
  const buf = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const art = createEnvelopeArtifacts(buf);
  return {
    create: {
      // Buffer ⇆ Prisma Bytes input: cast matches the `createMedia` factory.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bytes: art.bytes as any,
      mimeType,
      wrappedDek: art.wrappedDek,
    },
  };
}

/** Shorthand for the common url-media case (payload = the source URL string). */
export function envelopeCreateForUrl(url: string) {
  return envelopeCreateForPayload(url, URL_ENVELOPE_MIME);
}

// ── base64 / base64url ────────────────────────────────────────────────

/** Decode standard Base64 (with optional padding) to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

/**
 * Decode Base64url (URL-safe, optionally unpadded) to bytes. Mirrors
 * `base64urlToBytes` in `src/lib/client-crypto.ts`.
 */
export function base64urlToBytes(b64u: string): Uint8Array {
  let b = b64u.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  return base64ToBytes(b);
}

/**
 * Encode raw bytes to unpadded Base64url. Used to produce DEKs and
 * product keys in the shape the portal returns (`SecureRandom.urlsafe_base64(32)`).
 */
export function bytesToBase64url(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ── Key + fingerprint generation ──────────────────────────────────────

/**
 * Generate a Base64url-encoded 32-byte AES-256-GCM key, matching the
 * portal's `SecureRandom.urlsafe_base64(32)` output. Use as a stand-in
 * for the "fake portal key" the SatsRail mock returns in tests.
 */
export function genProductKey(): string {
  return bytesToBase64url(randomBytes(32));
}

/**
 * SHA-256(utf-8 bytes of `s`), hex-encoded. Mirrors:
 *   - Portal: `Digest::SHA256.hexdigest(key)` (in `app/models/product.rb`)
 *   - Client: `computeKeyFingerprint` (in `src/lib/client-crypto.ts`)
 * If these three ever disagree, every paying customer trips
 * `PaymentWall.fingerprint` failures — so this helper is the canonical
 * spot to assert byte-equality across the stack.
 */
export async function sha256HexOfString(s: string): Promise<string> {
  const h = await webcrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );
  return Array.from(new Uint8Array(h))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Decryption mirrors (Web Crypto) ───────────────────────────────────

/**
 * Mirror of `src/lib/client-crypto.ts` `decryptBlob` — AES-256-GCM with
 * `productId` as Additional Authenticated Data.
 *
 *   blob = Base64(IV[12] || ciphertext || authTag[16])
 *   key  = Base64url 32 bytes (portal product key)
 *   AAD  = utf-8 bytes of productId
 *
 * Throws on wrong key, wrong productId, or tampered ciphertext.
 */
export async function clientDecryptBlob(
  encryptedBase64: string,
  keyBase64url: string,
  productId: string
): Promise<Uint8Array> {
  const data = base64ToBytes(encryptedBase64);
  const iv = data.slice(0, 12);
  const ct = data.slice(12);
  const keyBytes = base64urlToBytes(keyBase64url);
  const cryptoKey = await webcrypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const pt = await webcrypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(productId),
    },
    cryptoKey,
    ct
  );
  return new Uint8Array(pt);
}

/**
 * Mirror of `src/lib/client-crypto.ts` `decryptBytesWithKey` —
 * AES-256-GCM with NO AAD. Used to decrypt photo bytes from GridFS
 * after the per-photo DEK has been unwrapped via `clientDecryptBlob`.
 *
 *   blob = raw bytes (IV[12] || ciphertext || authTag[16])
 *   key  = 32 raw bytes (the DEK)
 */
export async function clientDecryptBytesWithKey(
  blob: Uint8Array,
  keyBytes: Uint8Array
): Promise<Uint8Array> {
  const iv = blob.slice(0, 12);
  const ct = blob.slice(12);
  const cryptoKey = await webcrypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const pt = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
  return new Uint8Array(pt);
}
