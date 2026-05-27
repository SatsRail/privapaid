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

    it("accepts a photo blob", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "photo",
        envelopeId: "env_123",
        encryptedDek: "wrapped_dek_b64",
        mimeType: "image/jpeg",
      });
      expect(result.success).toBe(true);
    });

    it("rejects a photo blob missing encryptedDek (envelope encryption would break)", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "photo",
        envelopeId: "env_123",
        encryptedDek: "",
        mimeType: "image/jpeg",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a photo blob missing envelopeId", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "photo",
        envelopeId: "",
        encryptedDek: "wrapped",
        mimeType: "image/jpeg",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a photo blob missing mimeType", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "photo",
        envelopeId: "env_1",
        encryptedDek: "wrapped",
        mimeType: "",
      });
      expect(result.success).toBe(false);
    });

    it("accepts an article blob", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "article",
        envelopeId: "env_456",
        encryptedDek: "wrapped_dek_b64",
        mimeType: "text/markdown; charset=utf-8",
      });
      expect(result.success).toBe(true);
    });

    it("rejects an article blob missing encryptedDek", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "article",
        envelopeId: "env_456",
        encryptedDek: "",
        mimeType: "text/markdown; charset=utf-8",
      });
      expect(result.success).toBe(false);
    });

    it("rejects the legacy markdown discriminator (replaced by envelope-encrypted article)", () => {
      const result = mediaBlobSchema.safeParse({
        kind: "markdown",
        body: "# heading",
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
    it("maps article → article", () => {
      expect(expectedBlobKindFor("article")).toBe("article");
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

    it("returns the encryptedDek for a photo blob (NOT the envelopeId)", () => {
      // This is the patent-sensitive invariant: envelope encryption uses the
      // wrapped DEK as the per-product plaintext intermediate, not the
      // envelope row id (which is public). Callers must unwrap before
      // encrypting under a product key — `plaintextForEncryption` returns
      // the wrapped form so the schema module stays decoupled from CONTENT_KEK.
      const blob: MediaBlob = {
        kind: "photo",
        envelopeId: "env_visible",
        encryptedDek: "wrapped_secret",
        mimeType: "image/jpeg",
      };
      expect(plaintextForEncryption(blob)).toBe("wrapped_secret");
      expect(plaintextForEncryption(blob)).not.toBe("env_visible");
    });

    it("returns the encryptedDek for an article blob (parallels photo)", () => {
      const blob: MediaBlob = {
        kind: "article",
        envelopeId: "env_visible",
        encryptedDek: "wrapped_article_dek",
        mimeType: "text/markdown; charset=utf-8",
      };
      expect(plaintextForEncryption(blob)).toBe("wrapped_article_dek");
    });
  });
});
