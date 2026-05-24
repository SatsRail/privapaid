import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// ─── Branded types for secret keys ──────────────────────────────────

/** A 64-hex-char AES-256 encryption key (from SK_ENCRYPTION_KEY env var). */
export type EncryptionKey = Buffer & { readonly __brand: "EncryptionKey" };

/** An encrypted value in the format iv:authTag:ciphertext (all hex). */
export type EncryptedValue = string & { readonly __brand: "EncryptedValue" };

function getEncryptionKey(): EncryptionKey {
  const key = process.env.SK_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("Please define the SK_ENCRYPTION_KEY environment variable");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("SK_ENCRYPTION_KEY must be exactly 64 hex characters (256-bit key)");
  }
  return Buffer.from(key, "hex") as EncryptionKey;
}

/**
 * Encrypt a SatsRail sk_live_ key before storing in MongoDB.
 * Uses AES-256-GCM with a random IV per encryption.
 * Returns a string: iv:authTag:ciphertext (all hex-encoded).
 */
export function encryptSecretKey(plaintext: string): EncryptedValue {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}` as EncryptedValue;
}

/**
 * Decrypt a SatsRail sk_live_ key from MongoDB.
 *
 * Validates the envelope shape (`iv:authTag:ciphertext`, all hex)
 * before passing anything to `createDecipheriv` so callers get a clear
 * error message on malformed input instead of an opaque OpenSSL throw.
 */
export function decryptSecretKey(encryptedValue: EncryptedValue | string): string {
  const key = getEncryptionKey();
  const parts = encryptedValue.split(":");
  if (parts.length !== 3 || parts[0].length === 0 || parts[1].length === 0) {
    // ciphertext may legitimately be empty (encrypting "" produces an
    // envelope of `iv:tag:`); IV and auth tag must be present.
    throw new Error(
      "decryptSecretKey: malformed envelope (expected iv:authTag:ciphertext)"
    );
  }
  const [ivHex, authTagHex, ciphertext] = parts;
  if (
    !/^[0-9a-fA-F]+$/.test(ivHex) ||
    !/^[0-9a-fA-F]+$/.test(authTagHex) ||
    (ciphertext.length > 0 && !/^[0-9a-fA-F]+$/.test(ciphertext))
  ) {
    throw new Error("decryptSecretKey: envelope parts must be hex-encoded");
  }

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
