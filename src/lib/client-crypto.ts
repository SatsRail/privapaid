/**
 * Browser-side AES-256-GCM decryption using Web Crypto API.
 * Mirrors the server-side content-encryption.ts format:
 *   blob = Base64(IV[12] + ciphertext + authTag[16])
 *   key  = Base64url-encoded 32 bytes (delivered by SatsRail after payment)
 */

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decode a Base64url-encoded string to bytes.
 * Mirrors server-side base64urlDecode() in content-encryption.ts.
 * SatsRail stores product keys as SecureRandom.urlsafe_base64(32).
 */
export function base64urlToBytes(base64url: string): Uint8Array {
  let b64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return base64ToBytes(b64);
}

/**
 * Compute SHA-256 fingerprint of a key string (hex-encoded result).
 * Used to verify key authenticity before decryption.
 */
export async function computeKeyFingerprint(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify that a key matches an expected fingerprint.
 * Returns true if the key's SHA-256 matches the expected fingerprint.
 * If no fingerprint is provided, returns true (backwards compatible).
 */
export async function verifyKeyFingerprint(
  key: string,
  expectedFingerprint?: string
): Promise<boolean> {
  if (!expectedFingerprint) return true;
  const actual = await computeKeyFingerprint(key);
  return actual === expectedFingerprint;
}

/**
 * Decrypt a Base64-encoded AES-256-GCM blob using the Web Crypto API.
 *
 * The productId is used as AES-GCM Additional Authenticated Data (AAD),
 * ensuring the blob can only be decrypted in the context of the correct product.
 *
 * @param encryptedBase64 - Base64-encoded blob: IV[12] + ciphertext + authTag[16]
 * @param keyBase64url - Base64url-encoded 32-byte AES-256-GCM key from SatsRail
 * @param productId - SatsRail product UUID, used as AAD to verify the blob belongs to this product
 * @returns Decrypted bytes
 */
export async function decryptBlob(
  encryptedBase64: string,
  keyBase64url: string,
  productId: string
): Promise<Uint8Array> {
  const data = base64ToBytes(encryptedBase64);

  const iv = data.slice(0, IV_LENGTH);
  // Web Crypto expects ciphertext + authTag concatenated (which is what we have after IV)
  const ciphertextWithTag = data.slice(IV_LENGTH);

  const keyBytes = base64urlToBytes(keyBase64url);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(productId) },
    cryptoKey,
    ciphertextWithTag
  );

  return new Uint8Array(decrypted);
}

/**
 * Decrypt an AES-256-GCM blob with a raw 32-byte key, no AAD.
 *
 * Used for envelope-encrypted photo content: the per-photo DEK is unwrapped
 * via {@link decryptBlob} (which uses productId AAD), then this helper applies
 * the DEK to the GridFS ciphertext. Photo bytes aren't bound to a product at
 * the byte layer — that binding lives in the outer DEK envelope.
 *
 * Blob layout matches server-side encryptBytes(): IV[12] || ciphertext || authTag[16]
 */
export async function decryptBytesWithKey(
  blob: Uint8Array,
  keyBytes: Uint8Array
): Promise<Uint8Array> {
  if (keyBytes.length !== 32) {
    throw new Error(`Key must be 32 bytes, got ${keyBytes.length}`);
  }
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Blob too short");
  }

  const iv = blob.slice(0, IV_LENGTH);
  const ciphertextWithTag = blob.slice(IV_LENGTH);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    ciphertextWithTag
  );

  return new Uint8Array(decrypted);
}

export function detectMimeType(bytes: Uint8Array): string {
  // Check magic bytes
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    return "image/webp";
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x00) {
    return "video/mp4";
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf) {
    return "video/webm";
  }
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return "audio/mpeg";
  }

  // If it looks like a URL (starts with http), return as URL
  const text = new TextDecoder().decode(bytes.slice(0, 10));
  if (text.startsWith("http://") || text.startsWith("https://")) {
    return "text/url";
  }

  // Default: treat as text/html
  return "text/html";
}

export function bytesToUrl(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
