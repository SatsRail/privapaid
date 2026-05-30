-- Unify media content encryption.
--
-- EncryptedEnvelope → MediaEnvelope: now exactly ONE per media, holding every
-- media's encrypted payload (the source URL for url media, the content bytes for
-- photo/article). Adds `mediaId` (1:1 FK) + `wrappedDek` — the per-media DEK
-- wrapped under CONTENT_KEK, the operator recovery store that replaces Media.blob.
--
-- MediaEncryptedBlob → MediaProduct: the per-(product, media) row now wraps the
-- media DEK (`encryptedDek`) instead of the source directly. Patent claim 24
-- holds — still one AAD-bound row per (product, media).
--
-- Media.blob (the plaintext recovery store) is dropped.
--
-- Data handling (the "re-seed local, re-import demo" strategy):
--   - photo/article: backfilled in place below — the envelope already exists and
--     the DEK is recoverable from the old Media.blob.encryptedDek.
--   - url media: had no envelope; their MediaProduct rows still wrap the URL.
--     Re-seed (local) / re-import (demo) recreates the envelope and re-wraps the
--     DEK. URL media that is NOT re-imported will not decrypt until it is.

BEGIN;

-- 1. EncryptedEnvelope → MediaEnvelope (+ mediaId 1:1, wrappedDek, FK).
ALTER TABLE "EncryptedEnvelope" RENAME TO "MediaEnvelope";
ALTER TABLE "MediaEnvelope" RENAME CONSTRAINT "EncryptedEnvelope_pkey" TO "MediaEnvelope_pkey";
ALTER TABLE "MediaEnvelope"
  ADD COLUMN "mediaId"    TEXT,
  ADD COLUMN "wrappedDek" TEXT;
CREATE UNIQUE INDEX "MediaEnvelope_mediaId_key" ON "MediaEnvelope"("mediaId");
ALTER TABLE "MediaEnvelope" ADD CONSTRAINT "MediaEnvelope_mediaId_fkey"
  FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Backfill photo/article: link each envelope to its Media and copy the
--    wrapped DEK from the old Media.blob recovery store.
UPDATE "MediaEnvelope" me
SET "mediaId"    = m."id",
    "wrappedDek" = m."blob"->>'encryptedDek'
FROM "Media" m
WHERE m."mediaType" IN ('photo', 'article')
  AND m."blob"->>'envelopeId' = me."id";

-- 3. MediaEncryptedBlob → MediaProduct; encryptedSource → encryptedDek.
ALTER TABLE "MediaEncryptedBlob" RENAME TO "MediaProduct";
ALTER TABLE "MediaProduct" RENAME COLUMN "encryptedSource" TO "encryptedDek";
ALTER TABLE "MediaProduct" RENAME CONSTRAINT "MediaEncryptedBlob_pkey" TO "MediaProduct_pkey";
ALTER TABLE "MediaProduct" RENAME CONSTRAINT "MediaEncryptedBlob_productId_fkey" TO "MediaProduct_productId_fkey";
ALTER TABLE "MediaProduct" RENAME CONSTRAINT "MediaEncryptedBlob_mediaId_fkey" TO "MediaProduct_mediaId_fkey";
ALTER INDEX "MediaEncryptedBlob_productId_mediaId_key" RENAME TO "MediaProduct_productId_mediaId_key";
ALTER INDEX "MediaEncryptedBlob_mediaId_idx" RENAME TO "MediaProduct_mediaId_idx";
ALTER INDEX "MediaEncryptedBlob_productId_idx" RENAME TO "MediaProduct_productId_idx";

-- 4. Drop the now-migrated Media.blob plaintext store.
ALTER TABLE "Media" DROP COLUMN "blob";

COMMIT;
