import { z } from "zod";

/**
 * Type-discriminated payload stored in Media.blob (JSONB).
 *
 * Admin-only — public routes MUST omit this field on the wire. For envelope-
 * encrypted content (photo, article) the wrapped DEK on this row is what
 * lets the re-encryption flow rotate product keys without SatsRail's old_key.
 * For url-backed media the url itself is the plaintext recovery store.
 *
 * Shape per Media.mediaType:
 *   video / audio / podcast → { kind: "url",     url:  string }
 *   photo                   → { kind: "photo",
 *                               envelopeId:   EncryptedEnvelope.id,
 *                               encryptedDek: <DEK wrapped under CONTENT_KEK>,
 *                               mimeType:     string }
 *   article                 → { kind: "article",
 *                               envelopeId:   EncryptedEnvelope.id,
 *                               encryptedDek: <DEK wrapped under CONTENT_KEK>,
 *                               mimeType:     string }
 *
 * Validate at every write site. Prisma can't enforce JSONB shape; this
 * schema is the only source of truth for the field's structure.
 */

export const urlBlobSchema = z.object({
  kind: z.literal("url"),
  url: z.string().min(1, "url is required").max(8192, "url too long"),
});

const envelopeShape = {
  envelopeId: z.string().min(1, "envelopeId is required"),
  encryptedDek: z.string().min(1, "encryptedDek is required"),
  mimeType: z.string().min(1, "mimeType is required"),
};

export const photoBlobSchema = z.object({
  kind: z.literal("photo"),
  ...envelopeShape,
});

export const articleBlobSchema = z.object({
  kind: z.literal("article"),
  ...envelopeShape,
});

export const mediaBlobSchema = z.discriminatedUnion("kind", [
  urlBlobSchema,
  photoBlobSchema,
  articleBlobSchema,
]);

export type UrlBlob = z.infer<typeof urlBlobSchema>;
export type PhotoBlob = z.infer<typeof photoBlobSchema>;
export type ArticleBlob = z.infer<typeof articleBlobSchema>;
export type MediaBlob = z.infer<typeof mediaBlobSchema>;

/**
 * Maps a Media.mediaType enum value to the expected blob kind. Used by write
 * paths to assert that the caller is providing a blob shape that matches the
 * declared media type — a video row with a `photo` blob is a bug.
 */
export function expectedBlobKindFor(
  mediaType: "video" | "audio" | "podcast" | "article" | "photo"
): MediaBlob["kind"] {
  switch (mediaType) {
    case "photo":
      return "photo";
    case "article":
      return "article";
    default:
      return "url";
  }
}

/**
 * Parse a value into a MediaBlob, throwing on invalid shapes. Use this at
 * every read site that needs to interpret the blob (encryption, decryption,
 * admin display). At write sites prefer `mediaBlobSchema.safeParse(...)`
 * routed through `validateBody` for structured 400s.
 */
export function parseMediaBlob(raw: unknown): MediaBlob {
  return mediaBlobSchema.parse(raw);
}

/**
 * Extract the plaintext that should be encrypted under a product key for
 * this media. Video/audio/podcast → URL; photo/article → the wrapped DEK
 * (which, after the product-key unwrap, decrypts EncryptedEnvelope.bytes).
 */
export function plaintextForEncryption(blob: MediaBlob): string {
  switch (blob.kind) {
    case "url":
      return blob.url;
    case "photo":
    case "article":
      return blob.encryptedDek;
  }
}
