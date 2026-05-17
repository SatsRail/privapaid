import { describe, it, expect } from "vitest";
import { randomBytes } from "crypto";
import { encryptSecretKey, decryptSecretKey } from "@/lib/encryption";
import {
  encryptSourceUrl,
  decryptSourceUrl,
  encryptBytes,
  decryptBytes,
} from "@/lib/content-encryption";

/**
 * End-to-end encryption lifecycle tests.
 * These simulate the full product creation and key rotation flow
 * as it happens across the app.
 */

function generateProductKey(): string {
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const PRODUCT_A = "550e8400-e29b-41d4-a716-446655440000";
const PRODUCT_B = "660e8400-e29b-41d4-a716-446655440001";

describe("Encryption Lifecycle", () => {
  describe("Merchant key storage lifecycle", () => {
    it("encrypt → store → retrieve → decrypt merchant API key", () => {
      const originalKey = "sk_live_merchant_abc123";

      // Setup wizard encrypts the key before storing in Settings
      const encrypted = encryptSecretKey(originalKey);

      // getMerchantKey decrypts it when needed for API calls
      const decrypted = decryptSecretKey(encrypted);

      expect(decrypted).toBe(originalKey);
      expect(encrypted).not.toContain(originalKey);
    });

    it("each encryption produces unique ciphertext (can't compare encrypted values)", () => {
      const key = "sk_live_same_key";
      const a = encryptSecretKey(key);
      const b = encryptSecretKey(key);

      // Different IVs → different ciphertexts
      expect(a).not.toBe(b);

      // But both decrypt to the same value
      expect(decryptSecretKey(a)).toBe(key);
      expect(decryptSecretKey(b)).toBe(key);
    });
  });

  describe("Content encryption lifecycle (product creation)", () => {
    it("simulates create-product: encrypt source URL with product key", () => {
      const sourceUrl = "https://cdn.example.com/videos/private-content.mp4";
      const productKey = generateProductKey();

      // Step 1: Product created on SatsRail, get key
      // Step 2: Encrypt source URL
      const encrypted = encryptSourceUrl(sourceUrl, productKey, PRODUCT_A);

      // Step 3: Store encrypted blob in MediaProduct
      expect(encrypted).not.toContain(sourceUrl);
      expect(typeof encrypted).toBe("string");

      // Step 4: Customer purchases → gets key via macaroon → decrypts client-side
      const decrypted = decryptSourceUrl(encrypted, productKey, PRODUCT_A);
      expect(decrypted).toBe(sourceUrl);
    });

    it("different media items get different encrypted blobs even with same key", () => {
      const key = generateProductKey();
      const url1 = "https://cdn.example.com/video1.mp4";
      const url2 = "https://cdn.example.com/video2.mp4";

      const blob1 = encryptSourceUrl(url1, key, PRODUCT_A);
      const blob2 = encryptSourceUrl(url2, key, PRODUCT_A);

      // Different content → different blobs
      expect(blob1).not.toBe(blob2);

      // Both decrypt correctly
      expect(decryptSourceUrl(blob1, key, PRODUCT_A)).toBe(url1);
      expect(decryptSourceUrl(blob2, key, PRODUCT_A)).toBe(url2);
    });

    it("same URL encrypted twice produces different blobs (random IV)", () => {
      const key = generateProductKey();
      const url = "https://cdn.example.com/video.mp4";

      const blob1 = encryptSourceUrl(url, key, PRODUCT_A);
      const blob2 = encryptSourceUrl(url, key, PRODUCT_A);

      expect(blob1).not.toBe(blob2);
      expect(decryptSourceUrl(blob1, key, PRODUCT_A)).toBe(url);
      expect(decryptSourceUrl(blob2, key, PRODUCT_A)).toBe(url);
    });
  });

  describe("Key rotation lifecycle", () => {
    it("simulates full key rotation: old_key → re-encrypt → new_key", () => {
      const sourceUrl = "https://cdn.example.com/premium-video.mp4";

      // Initial state: encrypted with original key
      const originalKey = generateProductKey();
      const originalBlob = encryptSourceUrl(sourceUrl, originalKey, PRODUCT_A);

      // SatsRail rotates the key → product now has key (new) and old_key
      const newKey = generateProductKey();
      const oldKey = originalKey; // old_key = previous key

      // Re-encryption: decrypt with old_key, encrypt with new key
      const plainUrl = decryptSourceUrl(originalBlob, oldKey, PRODUCT_A);
      expect(plainUrl).toBe(sourceUrl);

      const newBlob = encryptSourceUrl(plainUrl, newKey, PRODUCT_A);

      // Verify new blob works with new key
      expect(decryptSourceUrl(newBlob, newKey, PRODUCT_A)).toBe(sourceUrl);

      // Old blob should NOT work with new key (keys are different)
      expect(() => decryptSourceUrl(originalBlob, newKey, PRODUCT_A)).toThrow();

      // New blob should NOT work with old key
      expect(() => decryptSourceUrl(newBlob, oldKey, PRODUCT_A)).toThrow();
    });

    it("simulates bulk re-encryption across multiple media products", () => {
      const urls = [
        "https://cdn.example.com/video1.mp4",
        "https://cdn.example.com/video2.mp4",
        "https://cdn.example.com/video3.mp4",
        "https://cdn.example.com/audio1.mp3",
        "https://cdn.example.com/article1.html",
      ];

      const oldKey = generateProductKey();
      const newKey = generateProductKey();

      // Encrypt all URLs with old key (initial state)
      const oldBlobs = urls.map((url) => encryptSourceUrl(url, oldKey, PRODUCT_A));

      // Re-encrypt all with new key (key rotation)
      const newBlobs = oldBlobs.map((blob) => {
        const plainUrl = decryptSourceUrl(blob, oldKey, PRODUCT_A);
        return encryptSourceUrl(plainUrl, newKey, PRODUCT_A);
      });

      // All new blobs decrypt correctly with new key
      for (let i = 0; i < urls.length; i++) {
        expect(decryptSourceUrl(newBlobs[i], newKey, PRODUCT_A)).toBe(urls[i]);
      }

      // All old blobs still work with old key (before clear_old_key)
      for (let i = 0; i < urls.length; i++) {
        expect(decryptSourceUrl(oldBlobs[i], oldKey, PRODUCT_A)).toBe(urls[i]);
      }

      // Old blobs fail with new key
      for (const blob of oldBlobs) {
        expect(() => decryptSourceUrl(blob, newKey, PRODUCT_A)).toThrow();
      }
    });

    it("re-encryption is idempotent (re-encrypt already re-encrypted blob)", () => {
      const url = "https://cdn.example.com/video.mp4";
      const key1 = generateProductKey();
      const key2 = generateProductKey();

      // Encrypt with key1
      const blob1 = encryptSourceUrl(url, key1, PRODUCT_A);

      // Re-encrypt to key2
      const plain = decryptSourceUrl(blob1, key1, PRODUCT_A);
      const blob2 = encryptSourceUrl(plain, key2, PRODUCT_A);

      // Re-encrypt again to key2 (idempotent — same result)
      const plain2 = decryptSourceUrl(blob2, key2, PRODUCT_A);
      expect(plain2).toBe(url);
      const blob3 = encryptSourceUrl(plain2, key2, PRODUCT_A);

      // All decrypt to the same URL
      expect(decryptSourceUrl(blob3, key2, PRODUCT_A)).toBe(url);
    });

    it("partial re-encryption failure leaves old blobs intact", () => {
      const urls = ["https://cdn.example.com/v1.mp4", "https://cdn.example.com/v2.mp4"];
      const oldKey = generateProductKey();
      const newKey = generateProductKey();

      const blobs = urls.map((url) => encryptSourceUrl(url, oldKey, PRODUCT_A));

      // Simulate: first succeeds, second "fails" (we skip it)
      const results: (string | null)[] = [];
      for (let i = 0; i < blobs.length; i++) {
        try {
          if (i === 1) throw new Error("Simulated failure");
          const plain = decryptSourceUrl(blobs[i], oldKey, PRODUCT_A);
          results.push(encryptSourceUrl(plain, newKey, PRODUCT_A));
        } catch {
          results.push(null); // Failed — keep old blob
        }
      }

      // First was re-encrypted successfully
      expect(results[0]).not.toBeNull();
      expect(decryptSourceUrl(results[0]!, newKey, PRODUCT_A)).toBe(urls[0]);

      // Second failed — old blob is still valid with old key
      expect(results[1]).toBeNull();
      expect(decryptSourceUrl(blobs[1], oldKey, PRODUCT_A)).toBe(urls[1]);
    });
  });

  describe("Cross-key isolation", () => {
    it("different products have different keys — cannot cross-decrypt", () => {
      const key1 = generateProductKey();
      const key2 = generateProductKey();

      const url1 = "https://cdn.example.com/product1/video.mp4";
      const url2 = "https://cdn.example.com/product2/video.mp4";

      const blob1 = encryptSourceUrl(url1, key1, PRODUCT_A);
      const blob2 = encryptSourceUrl(url2, key2, PRODUCT_B);

      // Each decrypts with its own key and product ID
      expect(decryptSourceUrl(blob1, key1, PRODUCT_A)).toBe(url1);
      expect(decryptSourceUrl(blob2, key2, PRODUCT_B)).toBe(url2);

      // Cross-decryption fails (GCM auth tag mismatch)
      expect(() => decryptSourceUrl(blob1, key2, PRODUCT_B)).toThrow();
      expect(() => decryptSourceUrl(blob2, key1, PRODUCT_A)).toThrow();
    });

    it("same key, different productId — cannot cross-decrypt (AAD mismatch)", () => {
      const key = generateProductKey();
      const url = "https://cdn.example.com/video.mp4";

      const blobA = encryptSourceUrl(url, key, PRODUCT_A);
      const blobB = encryptSourceUrl(url, key, PRODUCT_B);

      // Each decrypts with correct productId
      expect(decryptSourceUrl(blobA, key, PRODUCT_A)).toBe(url);
      expect(decryptSourceUrl(blobB, key, PRODUCT_B)).toBe(url);

      // Cross-product decryption fails even with same key
      expect(() => decryptSourceUrl(blobA, key, PRODUCT_B)).toThrow();
      expect(() => decryptSourceUrl(blobB, key, PRODUCT_A)).toThrow();
    });

    it("merchant key encryption is independent from content encryption", () => {
      // Merchant key uses hex-based AES-256-GCM (SK_ENCRYPTION_KEY env var)
      const merchantKey = "sk_live_abc123";
      const encrypted = encryptSecretKey(merchantKey);

      // Content encryption uses base64url-encoded product keys
      const productKey = generateProductKey();
      const sourceUrl = "https://cdn.example.com/video.mp4";
      const blob = encryptSourceUrl(sourceUrl, productKey, PRODUCT_A);

      // These use completely different key material and formats
      expect(encrypted).toContain(":"); // hex iv:tag:ciphertext
      expect(blob).not.toContain(":"); // base64 blob

      // Both decrypt correctly with their own keys
      expect(decryptSecretKey(encrypted)).toBe(merchantKey);
      expect(decryptSourceUrl(blob, productKey, PRODUCT_A)).toBe(sourceUrl);
    });
  });

  describe("GCM authentication (tamper detection)", () => {
    it("detects tampered encrypted source URL blob", () => {
      const key = generateProductKey();
      const url = "https://cdn.example.com/video.mp4";
      const blob = encryptSourceUrl(url, key, PRODUCT_A);

      // Tamper with the blob
      const raw = Buffer.from(blob, "base64");
      raw[20] ^= 0xff; // flip a byte in the ciphertext
      const tampered = raw.toString("base64");

      expect(() => decryptSourceUrl(tampered, key, PRODUCT_A)).toThrow();
    });

    it("detects tampered merchant key ciphertext", () => {
      const encrypted = encryptSecretKey("sk_live_test123");
      const parts = encrypted.split(":");

      // Tamper with the ciphertext portion
      const cipherBytes = Buffer.from(parts[2], "hex");
      cipherBytes[0] ^= 0xff;
      parts[2] = cipherBytes.toString("hex");
      const tampered = parts.join(":");

      expect(() => decryptSecretKey(tampered)).toThrow();
    });

    it("detects tampered IV in source URL blob", () => {
      const key = generateProductKey();
      const blob = encryptSourceUrl("https://example.com/test", key, PRODUCT_A);

      const raw = Buffer.from(blob, "base64");
      raw[0] ^= 0xff; // flip first byte of IV
      const tampered = raw.toString("base64");

      expect(() => decryptSourceUrl(tampered, key, PRODUCT_A)).toThrow();
    });

    it("detects tampered auth tag in source URL blob", () => {
      const key = generateProductKey();
      const blob = encryptSourceUrl("https://example.com/test", key, PRODUCT_A);

      const raw = Buffer.from(blob, "base64");
      raw[raw.length - 1] ^= 0xff; // flip last byte of auth tag
      const tampered = raw.toString("base64");

      expect(() => decryptSourceUrl(tampered, key, PRODUCT_A)).toThrow();
    });

    it("detects tampered IV in merchant key", () => {
      const encrypted = encryptSecretKey("sk_live_test");
      const parts = encrypted.split(":");

      const ivBytes = Buffer.from(parts[0], "hex");
      ivBytes[0] ^= 0xff;
      parts[0] = ivBytes.toString("hex");
      const tampered = parts.join(":");

      expect(() => decryptSecretKey(tampered)).toThrow();
    });

    it("detects tampered auth tag in merchant key", () => {
      const encrypted = encryptSecretKey("sk_live_test");
      const parts = encrypted.split(":");

      const tagBytes = Buffer.from(parts[1], "hex");
      tagBytes[0] ^= 0xff;
      parts[1] = tagBytes.toString("hex");
      const tampered = parts.join(":");

      expect(() => decryptSecretKey(tampered)).toThrow();
    });
  });

  // -------------------------------------------------------
  // Envelope encryption — full photo lifecycle
  // -------------------------------------------------------
  describe("Photo envelope encryption lifecycle", () => {
    function generateDek(): Buffer {
      return randomBytes(32);
    }

    function dekToBase64url(dek: Buffer): string {
      return dek
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    }

    function base64urlToDek(s: string): Buffer {
      let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      return Buffer.from(b64, "base64");
    }

    it("full lifecycle: upload → wrap → fetch → unwrap → decrypt → view", () => {
      // 1. UPLOAD (server-side, /api/admin/photos)
      const photoBytes = Buffer.from("the actual JPEG bytes — sensitive!");
      const dek = generateDek();
      const ciphertext = encryptBytes(photoBytes, dek); // → goes to GridFS

      // 2. CREATE-PRODUCT (server wraps the DEK with the SatsRail product key)
      const productKey = generateProductKey();
      const wrappedDek = encryptSourceUrl(dekToBase64url(dek), productKey, PRODUCT_A);
      // After this point, the server has discarded the DEK from memory.
      // At rest we have: { gridFs: ciphertext, MediaProduct.encrypted_source_url: wrappedDek }

      // 3. VIEWER unwraps DEK (after payment delivers productKey)
      const recoveredDekBase64url = decryptSourceUrl(wrappedDek, productKey, PRODUCT_A);
      const recoveredDek = base64urlToDek(recoveredDekBase64url);
      expect(recoveredDek.equals(dek)).toBe(true);

      // 4. VIEWER fetches ciphertext from GridFS and decrypts with the DEK
      const decrypted = decryptBytes(ciphertext, recoveredDek);
      expect(decrypted.equals(photoBytes)).toBe(true);
    });

    it("re-wrap: same photo bytes can be added to a SECOND product without re-upload", () => {
      const photoBytes = Buffer.from("one and only photo");
      const dek = generateDek();
      const ciphertext = encryptBytes(photoBytes, dek);

      // First product wraps the DEK
      const keyA = generateProductKey();
      const wrappedForA = encryptSourceUrl(dekToBase64url(dek), keyA, PRODUCT_A);

      // ---- some time later ----
      // To add the photo to a second product, server recovers the DEK from
      // the first envelope, then re-wraps under product B's key.
      const recoveredDek = base64urlToDek(decryptSourceUrl(wrappedForA, keyA, PRODUCT_A));
      const keyB = generateProductKey();
      const wrappedForB = encryptSourceUrl(dekToBase64url(recoveredDek), keyB, PRODUCT_B);

      // Both envelopes recover the same DEK
      const fromA = base64urlToDek(decryptSourceUrl(wrappedForA, keyA, PRODUCT_A));
      const fromB = base64urlToDek(decryptSourceUrl(wrappedForB, keyB, PRODUCT_B));
      expect(fromA.equals(fromB)).toBe(true);

      // Viewer with EITHER product key recovers the photo
      expect(decryptBytes(ciphertext, fromA).equals(photoBytes)).toBe(true);
      expect(decryptBytes(ciphertext, fromB).equals(photoBytes)).toBe(true);

      // Different envelopes for the same DEK look different on disk (random IV)
      expect(wrappedForA).not.toBe(wrappedForB);
    });

    it("cross-product isolation: product A's key cannot unwrap product B's envelope", () => {
      const photoBytes = Buffer.from("locked content");
      const dek = generateDek();
      encryptBytes(photoBytes, dek);

      const keyA = generateProductKey();
      const keyB = generateProductKey();
      const wrappedForA = encryptSourceUrl(dekToBase64url(dek), keyA, PRODUCT_A);

      // Wrong key — should fail
      expect(() => decryptSourceUrl(wrappedForA, keyB, PRODUCT_A)).toThrow();
      // Wrong productId AAD — should fail even with the right key
      expect(() => decryptSourceUrl(wrappedForA, keyA, PRODUCT_B)).toThrow();
    });

    it("tampered ciphertext fails GCM auth and surfaces as a decrypt error", () => {
      const photoBytes = Buffer.from("don't change me");
      const dek = generateDek();
      const ciphertext = encryptBytes(photoBytes, dek);

      // Attacker swaps a byte in the GridFS bytes
      ciphertext[20] = ciphertext[20] ^ 0xff;
      expect(() => decryptBytes(ciphertext, dek)).toThrow();
    });

    it("lost DEK = unrecoverable photo (no fallback path)", () => {
      // This test documents the load-bearing assumption: if the server
      // discards the DEK before wrapping (e.g. all MediaProducts deleted),
      // there is NO way to recover the photo. Production code must prevent
      // photo Media creation without at least one product wrap.
      const photoBytes = Buffer.from("forgotten");
      const dek = generateDek();
      const ciphertext = encryptBytes(photoBytes, dek);

      // Throw away the DEK — try with another random key, must fail.
      const otherKey = randomBytes(32);
      expect(() => decryptBytes(ciphertext, otherKey)).toThrow();
    });
  });
});
