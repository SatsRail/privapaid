import { z } from "zod";

/**
 * Type-discriminated payload stored in Media.blob (JSONB).
 *
 * Admin-only — public routes MUST omit this field on the wire. The
 * re-encryption flow reads it directly so key rotation doesn't depend
 * on SatsRail's old_key.
 *
 * Shape per Media.mediaType:
 *   video / audio / podcast → { kind: "url",      url:  string }
 *   article                 → { kind: "markdown", body: string }
 *   photo                   → { kind: "photo",
 *                               blobId:       EncryptedPhotoBlob.id,
 *                               encryptedDek: <DEK wrapped under PHOTO_KEK>,
 *                               mimeType:     string }
 *
 * Validate at every write site. Prisma can't enforce JSONB shape; this
 * schema is the only source of truth for the field's structure.
 */

export const urlBlobSchema = z.object({
  kind: z.literal("url"),
  url: z.string().min(1, "url is required").max(8192, "url too long"),
});

export const markdownBlobSchema = z.object({
  kind: z.literal("markdown"),
  body: z.string(),
});

export const photoBlobSchema = z.object({
  kind: z.literal("photo"),
  blobId: z.string().min(1, "blobId is required"),
  encryptedDek: z.string().min(1, "encryptedDek is required"),
  mimeType: z.string().min(1, "mimeType is required"),
});

export const mediaBlobSchema = z.discriminatedUnion("kind", [
  urlBlobSchema,
  markdownBlobSchema,
  photoBlobSchema,
]);

export type UrlBlob = z.infer<typeof urlBlobSchema>;
export type MarkdownBlob = z.infer<typeof markdownBlobSchema>;
export type PhotoBlob = z.infer<typeof photoBlobSchema>;
export type MediaBlob = z.infer<typeof mediaBlobSchema>;

/**
 * Maps a Media.mediaType enum value to the expected blob kind. Used by write
 * paths to assert that the caller is providing a blob shape that matches the
 * declared media type — a video row with a `markdown` blob is a bug.
 */
export function expectedBlobKindFor(
  mediaType: "video" | "audio" | "podcast" | "article" | "photo"
): MediaBlob["kind"] {
  switch (mediaType) {
    case "article":
      return "markdown";
    case "photo":
      return "photo";
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
 * this media. Video/audio/podcast → URL; article → body; photo → the wrapped
 * DEK (used to decrypt EncryptedPhotoBlob.bytes after unwrapping with the
 * product key).
 */
export function plaintextForEncryption(blob: MediaBlob): string {
  switch (blob.kind) {
    case "url":
      return blob.url;
    case "markdown":
      return blob.body;
    case "photo":
      return blob.encryptedDek;
  }
}
