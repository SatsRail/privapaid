import { describe, it, expect } from "vitest";
import {
  mediaBlobSchema,
  parseMediaBlob,
  expectedBlobKindFor,
  plaintextForEncryption,
  type MediaBlob,
} from "@/lib/schemas/media-blob";

describe("Media.blob schema", () => {
  describe("mediaBlobSchema", () => {
    it("accepts a url blob", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "url",
        url: "https://example.com/v.mp4",
      });
      expect(result.success).toBe(true);
    });

    it("rejects an empty url", () => {
      const result = mediaBlobSchema.safeParse({ kind: "url", url: "" });
      expect(result.success).toBe(false);
    });

    it("rejects a url over 8192 chars", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "url",
        url: "x".repeat(8193),
      });
      expect(result.success).toBe(false);
    });

    it("accepts a markdown blob", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "markdown",
        body: "# heading",
      });
      expect(result.success).toBe(true);
    });

    it("accepts an empty markdown body (drafts can be empty)", () => {
      const result = mediaBlobSchema.safeParse({ kind: "markdown", body: "" });
      expect(result.success).toBe(true);
    });

    it("accepts a photo blob", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "photo",
        blobId: "blob_123",
        encryptedDek: "wrapped_dek_b64",
        mimeType: "image/jpeg",
      });
      expect(result.success).toBe(true);
    });

    it("rejects a photo blob missing encryptedDek (envelope encryption would break)", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "photo",
        blobId: "blob_123",
        encryptedDek: "",
        mimeType: "image/jpeg",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a photo blob missing blobId", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "photo",
        blobId: "",
        encryptedDek: "wrapped",
        mimeType: "image/jpeg",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a photo blob missing mimeType", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "photo",
        blobId: "blob_1",
        encryptedDek: "wrapped",
        mimeType: "",
      });
      expect(result.success).toBe(false);
    });

    it("rejects an unknown discriminator", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "binary",
        bytes: "abc",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a missing discriminator", () => {
      const result = mediaBlobSchema.safeParse({ url: "https://x" });
      expect(result.success).toBe(false);
    });
  });

  describe("parseMediaBlob", () => {
    it("returns the typed blob for valid input", () => {
      const blob = parseMediaBlob({ kind: "url", url: "https://x.com/v.mp4" });
      expect(blob.kind).toBe("url");
      if (blob.kind === "url") expect(blob.url).toBe("https://x.com/v.mp4");
    });

    it("throws on invalid input (used at read sites that have already trusted Postgres)", () => {
      expect(() => parseMediaBlob({ kind: "url" })).toThrow();
    });
  });

  describe("expectedBlobKindFor", () => {
    it("maps article → markdown", () => {
      expect(expectedBlobKindFor("article")).toBe("markdown");
    });

    it("maps photo → photo", () => {
      expect(expectedBlobKindFor("photo")).toBe("photo");
    });

    it("maps video → url", () => {
      expect(expectedBlobKindFor("video")).toBe("url");
    });

    it("maps audio → url", () => {
      expect(expectedBlobKindFor("audio")).toBe("url");
    });

    it("maps podcast → url (default branch)", () => {
      expect(expectedBlobKindFor("podcast")).toBe("url");
    });
  });

  describe("plaintextForEncryption", () => {
    it("extracts the URL from a url blob", () => {
      const blob: MediaBlob = { kind: "url", url: "https://example.com/v.mp4" };
      expect(plaintextForEncryption(blob)).toBe("https://example.com/v.mp4");
    });

    it("extracts the body from a markdown blob", () => {
      const blob: MediaBlob = { kind: "markdown", body: "secret text" };
      expect(plaintextForEncryption(blob)).toBe("secret text");
    });

    it("extracts the encryptedDek from a photo blob (NOT the blobId)", () => {
      // This is the patent-sensitive invariant: photo encryption envelope-wraps
      // the DEK, not the blobId. Confusing the two would let anyone with read
      // access to the row decrypt the bytes.
      const blob: MediaBlob = {
        kind: "photo",
        blobId: "blob_visible",
        encryptedDek: "wrapped_secret",
        mimeType: "image/jpeg",
      };
      expect(plaintextForEncryption(blob)).toBe("wrapped_secret");
      expect(plaintextForEncryption(blob)).not.toBe("blob_visible");
    });
  });
});
