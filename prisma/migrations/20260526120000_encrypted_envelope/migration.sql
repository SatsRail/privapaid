-- Encrypted envelope refactor:
--   1. Rename EncryptedPhotoBlob → EncryptedEnvelope (generic ciphertext-at-rest table).
--   2. Rename MediaEncryptedBlob.encryptedSourceUrl → encryptedSource (field now also
--      carries wrapped DEKs for articles, not just URLs/markdown).
--   3. Rewrite the JSONB key `blobId` → `envelopeId` on existing photo Media rows.
--   4. Add PreviewImage table for the /api/images shim (separates unencrypted preview
--      bytes from the envelope ciphertext table).

BEGIN;

-- 1. Encrypted envelope: table + primary key constraint rename.
ALTER TABLE "EncryptedPhotoBlob" RENAME TO "EncryptedEnvelope";
ALTER TABLE "EncryptedEnvelope"
  RENAME CONSTRAINT "EncryptedPhotoBlob_pkey" TO "EncryptedEnvelope_pkey";

-- 2. MediaEncryptedBlob field rename.
ALTER TABLE "MediaEncryptedBlob"
  RENAME COLUMN "encryptedSourceUrl" TO "encryptedSource";

-- 3. JSONB key rename for existing photo blobs: blobId → envelopeId.
UPDATE "Media"
SET "blob" = jsonb_set("blob" - 'blobId', '{envelopeId}', "blob"->'blobId')
WHERE "mediaType" = 'photo' AND "blob" ? 'blobId';

-- 4. PreviewImage table for unencrypted preview/thumbnail uploads.
CREATE TABLE "PreviewImage" (
  "id"        TEXT NOT NULL,
  "bytes"     BYTEA NOT NULL,
  "mimeType"  TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreviewImage_pkey" PRIMARY KEY ("id")
);

COMMIT;
