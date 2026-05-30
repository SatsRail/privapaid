/**
 * MediaEnvelope helpers — the uniform envelope-encryption layer.
 *
 * Every Media has exactly one MediaEnvelope holding its encrypted payload:
 *   - url media (video/audio/podcast): payload = the source URL (UTF-8 bytes)
 *   - photo/article:                   payload = the content bytes
 *
 * The payload is encrypted under a fresh per-media DEK (AES-256-GCM, no AAD).
 * Two copies of that DEK exist:
 *   - MediaEnvelope.wrappedDek: the DEK wrapped under the operator CONTENT_KEK,
 *     for server-side recovery (key rotation, admin preview) without a SatsRail
 *     round-trip. This is the only at-rest key copy and it never leaves the DB
 *     in usable form (the KEK lives in the operator env).
 *   - MediaProduct.encryptedDek: the DEK wrapped under each SatsRail product key
 *     (via encryptSourceUrl, AAD=productId) — the buyer's path.
 *
 * Buyer: productKey → decrypt MediaProduct.encryptedDek → DEK → decrypt
 *        MediaEnvelope.bytes → payload → render. (All client-side.)
 */

import { randomBytes } from "crypto";
import { encryptBytes, decryptBytes } from "@/lib/content-encryption";
import { wrapDek, unwrapDek, unwrapDekToBase64url } from "@/lib/content-dek";

/**
 * Content-Type stored on a url-media envelope. The client keys off
 * Media.mediaType (not this) to decide how to render, but the envelope route
 * needs a MIME and `client-crypto.detectMimeType` already maps URL bytes to it.
 */
export const URL_ENVELOPE_MIME = "text/url";

export interface EnvelopeArtifacts {
  /** encryptBytes(payload, DEK) — binary IV[12] || ciphertext || authTag[16]. */
  bytes: Buffer;
  /** wrapDek(DEK) under CONTENT_KEK — Base64 string for at-rest storage. */
  wrappedDek: string;
  /** The raw media DEK, Base64url — the per-product plaintext for encryptSourceUrl. */
  dekBase64url: string;
}

function bytesToBase64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint a fresh per-media DEK and produce the envelope ciphertext + wrapped DEK
 * for a payload. `dekBase64url` is wrapped under each SatsRail product key by
 * the caller (encryptSourceUrl) into MediaProduct.encryptedDek.
 */
export function createEnvelopeArtifacts(payload: Buffer | Uint8Array): EnvelopeArtifacts {
  const dekBytes = randomBytes(32);
  return {
    bytes: encryptBytes(payload, dekBytes),
    wrappedDek: wrapDek(dekBytes),
    dekBase64url: bytesToBase64url(dekBytes),
  };
}

/**
 * Recover the per-product plaintext (the media DEK, Base64url) from an
 * envelope's wrappedDek. This is the universal value wrapped under a SatsRail
 * product key via `encryptSourceUrl` — replaces the old per-kind
 * `plaintextForEncryption`.
 */
export function dekBase64urlFromEnvelope(envelope: { wrappedDek: string | null }): string {
  if (!envelope.wrappedDek) {
    throw new Error("MediaEnvelope.wrappedDek is missing; cannot derive product DEK");
  }
  return unwrapDekToBase64url(envelope.wrappedDek);
}

/**
 * Re-encrypt a new payload under the envelope's EXISTING DEK (article body edit,
 * url source change). The DEK — and therefore every MediaProduct row — stays
 * valid; only the envelope bytes change. Returns the new ciphertext.
 */
export function reencryptEnvelopeBytes(
  envelope: { wrappedDek: string | null },
  payload: Buffer | Uint8Array
): Buffer {
  if (!envelope.wrappedDek) {
    throw new Error("MediaEnvelope.wrappedDek is missing; cannot re-encrypt envelope");
  }
  const dekBytes = unwrapDek(envelope.wrappedDek);
  return encryptBytes(payload, dekBytes);
}

/**
 * Admin-only: recover the plaintext payload (URL string bytes or content bytes)
 * from an envelope. NEVER call on a buyer-facing path — buyers decrypt in the
 * browser. Used by preview/export/report-error (owner-gated).
 */
export function decryptEnvelopePayload(envelope: {
  bytes: Buffer | Uint8Array;
  wrappedDek: string | null;
}): Buffer {
  if (!envelope.wrappedDek) {
    throw new Error("MediaEnvelope.wrappedDek is missing; cannot decrypt envelope");
  }
  const dekBytes = unwrapDek(envelope.wrappedDek);
  return decryptBytes(envelope.bytes, dekBytes);
}
