import { describe, it, expect, afterEach } from "vitest";
import { encryptSecretKey, decryptSecretKey } from "@/lib/encryption";

describe("encryption", () => {
  const originalKey = process.env.SK_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.SK_ENCRYPTION_KEY = originalKey;
  });

  describe("encryptSecretKey / decryptSecretKey", () => {
    it("round-trips correctly", () => {
      const plaintext = "sk_live_abc123def456";
      const encrypted = encryptSecretKey(plaintext);
      const decrypted = decryptSecretKey(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertexts for the same plaintext (random IV)", () => {
      const plaintext = "sk_live_abc123def456";
      const a = encryptSecretKey(plaintext);
      const b = encryptSecretKey(plaintext);
      expect(a).not.toBe(b);
    });

    it("encrypted format is iv:authTag:ciphertext (hex)", () => {
      const encrypted = encryptSecretKey("test");
      const parts = encrypted.split(":");
      expect(parts).toHaveLength(3);
      // IV is 12 bytes = 24 hex chars
      expect(parts[0]).toHaveLength(24);
      // Auth tag is 16 bytes = 32 hex chars
      expect(parts[1]).toHaveLength(32);
      // Ciphertext is hex
      expect(parts[2]).toMatch(/^[0-9a-f]+$/);
    });

    it("handles empty string", () => {
      const encrypted = encryptSecretKey("");
      const decrypted = decryptSecretKey(encrypted);
      expect(decrypted).toBe("");
    });

    it("handles long strings", () => {
      const plaintext = "sk_live_" + "a".repeat(1000);
      const encrypted = encryptSecretKey(plaintext);
      const decrypted = decryptSecretKey(encrypted);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("missing/invalid key", () => {
    it("throws when SK_ENCRYPTION_KEY is not set", () => {
      delete process.env.SK_ENCRYPTION_KEY;
      expect(() => encryptSecretKey("test")).toThrow("SK_ENCRYPTION_KEY");
    });

    it("throws when SK_ENCRYPTION_KEY is wrong length", () => {
      process.env.SK_ENCRYPTION_KEY = "abcdef";
      expect(() => encryptSecretKey("test")).toThrow("64 hex characters");
    });

    it("throws when SK_ENCRYPTION_KEY has non-hex chars", () => {
      process.env.SK_ENCRYPTION_KEY = "g".repeat(64);
      expect(() => encryptSecretKey("test")).toThrow("64 hex characters");
    });
  });
});
