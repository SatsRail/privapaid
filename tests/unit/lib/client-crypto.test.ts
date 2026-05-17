import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  hexToBytes,
  base64ToBytes,
  base64urlToBytes,
  detectMimeType,
  bytesToUrl,
  computeKeyFingerprint,
  verifyKeyFingerprint,
  decryptBlob,
  decryptBytesWithKey,
} from "@/lib/client-crypto";

describe("client-crypto utilities", () => {
  describe("hexToBytes", () => {
    it("converts hex string to Uint8Array", () => {
      const result = hexToBytes("48656c6c6f");
      expect(result).toEqual(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    });

    it("converts empty hex string", () => {
      const result = hexToBytes("");
      expect(result).toEqual(new Uint8Array([]));
    });

    it("handles lowercase hex", () => {
      const result = hexToBytes("ff00ab");
      expect(result).toEqual(new Uint8Array([255, 0, 171]));
    });

    it("handles uppercase hex", () => {
      const result = hexToBytes("FF00AB");
      expect(result).toEqual(new Uint8Array([255, 0, 171]));
    });
  });

  describe("base64ToBytes", () => {
    it("converts base64 string to bytes", () => {
      // "Hello" in base64 = "SGVsbG8="
      const result = base64ToBytes("SGVsbG8=");
      const text = new TextDecoder().decode(result);
      expect(text).toBe("Hello");
    });

    it("handles empty base64", () => {
      const result = base64ToBytes("");
      expect(result.length).toBe(0);
    });
  });

  describe("base64urlToBytes", () => {
    it("converts base64url (replaces - and _ chars) to bytes", () => {
      // Standard base64 "n+8/x" => base64url "n-8_x"
      const standard = base64ToBytes("n+8/xw==");
      const urlsafe = base64urlToBytes("n-8_xw");
      expect(urlsafe).toEqual(standard);
    });

    it("pads base64url to correct length", () => {
      // "AA" in base64url needs padding to "AA=="
      const result = base64urlToBytes("AA");
      expect(result).toEqual(new Uint8Array([0]));
    });
  });

  describe("detectMimeType", () => {
    it("detects JPEG magic bytes", () => {
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
      expect(detectMimeType(bytes)).toBe("image/jpeg");
    });

    it("detects PNG magic bytes", () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      expect(detectMimeType(bytes)).toBe("image/png");
    });

    it("detects GIF magic bytes", () => {
      const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]);
      expect(detectMimeType(bytes)).toBe("image/gif");
    });

    it("detects WEBP magic bytes (RIFF header)", () => {
      const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00]);
      expect(detectMimeType(bytes)).toBe("image/webp");
    });

    it("detects MP4 magic bytes", () => {
      const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66]);
      expect(detectMimeType(bytes)).toBe("video/mp4");
    });

    it("detects WebM magic bytes", () => {
      const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]);
      expect(detectMimeType(bytes)).toBe("video/webm");
    });

    it("detects MP3 (ID3) magic bytes", () => {
      const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
      expect(detectMimeType(bytes)).toBe("audio/mpeg");
    });

    it("detects http URL as text/url", () => {
      const text = "https://example.com/video.mp4";
      const bytes = new TextEncoder().encode(text);
      expect(detectMimeType(bytes)).toBe("text/url");
    });

    it("detects http:// URL as text/url", () => {
      const text = "http://example.com/image.jpg";
      const bytes = new TextEncoder().encode(text);
      expect(detectMimeType(bytes)).toBe("text/url");
    });

    it("returns text/html for unknown content", () => {
      const bytes = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]); // "<html"
      expect(detectMimeType(bytes)).toBe("text/html");
    });
  });

  describe("bytesToUrl", () => {
    it("converts bytes to a URL string", () => {
      const url = "https://example.com/video.mp4";
      const bytes = new TextEncoder().encode(url);
      expect(bytesToUrl(bytes)).toBe(url);
    });

    it("handles empty bytes", () => {
      const bytes = new Uint8Array([]);
      expect(bytesToUrl(bytes)).toBe("");
    });
  });
});

describe("client-crypto Web Crypto functions", () => {
  const originalCrypto = globalThis.crypto;

  const mockDigest = vi.fn();
  const mockImportKey = vi.fn();
  const mockDecrypt = vi.fn();

  beforeEach(() => {
    mockDigest.mockReset();
    mockImportKey.mockReset();
    mockDecrypt.mockReset();

    Object.defineProperty(globalThis, "crypto", {
      value: {
        subtle: {
          digest: mockDigest,
          importKey: mockImportKey,
          decrypt: mockDecrypt,
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      writable: true,
      configurable: true,
    });
  });

  describe("computeKeyFingerprint", () => {
    it("returns hex-encoded SHA-256 digest of the key", async () => {
      // SHA-256 produces 32 bytes; mock a simple hash result
      const fakeHash = new Uint8Array([
        0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45,
        0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89,
      ]);
      mockDigest.mockResolvedValue(fakeHash.buffer);

      const result = await computeKeyFingerprint("test-key");

      expect(mockDigest).toHaveBeenCalledWith(
        "SHA-256",
        new TextEncoder().encode("test-key")
      );
      expect(result).toBe(
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
      );
    });

    it("encodes single-digit hex values with leading zero", async () => {
      const fakeHash = new Uint8Array([0x00, 0x0a]);
      mockDigest.mockResolvedValue(fakeHash.buffer);

      const result = await computeKeyFingerprint("k");
      expect(result).toBe("000a");
    });
  });

  describe("verifyKeyFingerprint", () => {
    it("returns true when no expected fingerprint is provided", async () => {
      const result = await verifyKeyFingerprint("any-key");
      expect(result).toBe(true);
      expect(mockDigest).not.toHaveBeenCalled();
    });

    it("returns true when expected fingerprint is empty string", async () => {
      const result = await verifyKeyFingerprint("any-key", "");
      expect(result).toBe(true);
      expect(mockDigest).not.toHaveBeenCalled();
    });

    it("returns true when fingerprint matches", async () => {
      const fakeHash = new Uint8Array([0xaa, 0xbb]);
      mockDigest.mockResolvedValue(fakeHash.buffer);

      const result = await verifyKeyFingerprint("my-key", "aabb");
      expect(result).toBe(true);
    });

    it("returns false when fingerprint does not match", async () => {
      const fakeHash = new Uint8Array([0xaa, 0xbb]);
      mockDigest.mockResolvedValue(fakeHash.buffer);

      const result = await verifyKeyFingerprint("my-key", "ccdd");
      expect(result).toBe(false);
    });
  });

  describe("decryptBlob", () => {
    it("decrypts a base64 blob with AES-256-GCM using Web Crypto", async () => {
      // Build a fake encrypted blob: IV (12 bytes) + ciphertext + authTag (16 bytes)
      const iv = new Uint8Array(12).fill(0x01);
      const ciphertextWithTag = new Uint8Array(20).fill(0x02); // arbitrary
      const combined = new Uint8Array(iv.length + ciphertextWithTag.length);
      combined.set(iv, 0);
      combined.set(ciphertextWithTag, iv.length);

      // Base64-encode the combined blob
      const encryptedBase64 = btoa(
        String.fromCharCode(...combined)
      );

      // Base64url key (32 bytes)
      const keyBytes = new Uint8Array(32).fill(0xaa);
      const keyBase64url = btoa(String.fromCharCode(...keyBytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      const fakeCryptoKey = { type: "secret" } as CryptoKey;
      mockImportKey.mockResolvedValue(fakeCryptoKey);

      const decryptedContent = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
      mockDecrypt.mockResolvedValue(decryptedContent.buffer);

      const productId = "prod-uuid-123";
      const result = await decryptBlob(encryptedBase64, keyBase64url, productId);

      // Verify importKey was called correctly
      expect(mockImportKey).toHaveBeenCalledWith(
        "raw",
        expect.any(ArrayBuffer),
        { name: "AES-GCM" },
        false,
        ["decrypt"]
      );

      // Verify decrypt was called with correct IV and AAD
      expect(mockDecrypt).toHaveBeenCalledWith(
        {
          name: "AES-GCM",
          iv: expect.any(Uint8Array),
          additionalData: new TextEncoder().encode(productId),
        },
        fakeCryptoKey,
        expect.any(Uint8Array)
      );

      // The IV passed to decrypt should be the first 12 bytes
      const decryptCall = mockDecrypt.mock.calls[0];
      const passedIv = decryptCall[0].iv;
      expect(passedIv).toEqual(iv);

      // The ciphertext+tag should be everything after IV
      const passedCiphertext = decryptCall[2];
      expect(passedCiphertext).toEqual(ciphertextWithTag);

      // Result should be the decrypted bytes
      expect(result).toEqual(decryptedContent);
    });

    it("propagates errors from crypto.subtle.decrypt", async () => {
      const iv = new Uint8Array(12).fill(0x00);
      const ciphertext = new Uint8Array(20).fill(0x00);
      const combined = new Uint8Array(32);
      combined.set(iv, 0);
      combined.set(ciphertext, 12);
      const encryptedBase64 = btoa(String.fromCharCode(...combined));

      const keyBytes = new Uint8Array(32).fill(0xbb);
      const keyBase64url = btoa(String.fromCharCode(...keyBytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      mockImportKey.mockResolvedValue({ type: "secret" } as CryptoKey);
      mockDecrypt.mockRejectedValue(new DOMException("Decryption failed"));

      await expect(
        decryptBlob(encryptedBase64, keyBase64url, "prod-456")
      ).rejects.toThrow("Decryption failed");
    });
  });

  describe("decryptBytesWithKey", () => {
    it("decrypts raw bytes using a 32-byte key, with no AAD", async () => {
      const iv = new Uint8Array(12).fill(0x05);
      const ciphertextWithTag = new Uint8Array(40).fill(0x06);
      const combined = new Uint8Array(iv.length + ciphertextWithTag.length);
      combined.set(iv, 0);
      combined.set(ciphertextWithTag, iv.length);

      const keyBytes = new Uint8Array(32).fill(0xcc);

      const fakeCryptoKey = { type: "secret" } as CryptoKey;
      mockImportKey.mockResolvedValue(fakeCryptoKey);
      const decryptedContent = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      mockDecrypt.mockResolvedValue(decryptedContent.buffer);

      const result = await decryptBytesWithKey(combined, keyBytes);

      expect(mockImportKey).toHaveBeenCalledWith(
        "raw",
        expect.any(ArrayBuffer),
        { name: "AES-GCM" },
        false,
        ["decrypt"]
      );

      // Critically: no `additionalData` field in the decrypt call. The DEK
      // envelope binds the photo to a product, so the photo bytes themselves
      // carry no AAD — adding one would break envelope reuse across products.
      expect(mockDecrypt).toHaveBeenCalledWith(
        { name: "AES-GCM", iv: expect.any(Uint8Array) },
        fakeCryptoKey,
        expect.any(Uint8Array)
      );
      const decryptCall = mockDecrypt.mock.calls[0];
      expect(decryptCall[0]).not.toHaveProperty("additionalData");
      expect(decryptCall[0].iv).toEqual(iv);

      expect(result).toEqual(decryptedContent);
    });

    it("throws if the key is not 32 bytes", async () => {
      const blob = new Uint8Array(40);
      const shortKey = new Uint8Array(16);
      await expect(decryptBytesWithKey(blob, shortKey)).rejects.toThrow(/32 bytes/);
    });

    it("throws if the blob is shorter than IV + auth tag", async () => {
      const tinyBlob = new Uint8Array(10);
      const key = new Uint8Array(32);
      await expect(decryptBytesWithKey(tinyBlob, key)).rejects.toThrow(/too short/i);
    });

    it("propagates Web Crypto decrypt errors (tamper / wrong key)", async () => {
      const blob = new Uint8Array(40);
      const key = new Uint8Array(32);
      mockImportKey.mockResolvedValue({ type: "secret" } as CryptoKey);
      mockDecrypt.mockRejectedValue(new DOMException("Decryption failed"));
      await expect(decryptBytesWithKey(blob, key)).rejects.toThrow("Decryption failed");
    });
  });
});
