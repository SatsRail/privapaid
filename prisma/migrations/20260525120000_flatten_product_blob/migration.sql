-- Flatten product/blob schema:
--   ChannelProduct + MediaProduct + ChannelProductMedia
--     →
--   Product (polymorphic via nullable channelId/mediaId) + MediaEncryptedBlob
--
-- Also replaces Media.sourceUrl + Media.encryptedDek with Media.blob (JSONB).
--
-- This migration handles both:
--   (a) Fresh installs: legacy tables don't exist; only the new tables are
--       created. Backfill steps no-op.
--   (b) Existing installs: legacy tables are read, data is copied into the
--       new shape, then the legacy tables are dropped.
--
-- See internal plan: privapaid-in-the-app-flatten-product-blob (.claude/plans, local-only)

BEGIN;

-- ── 1. New Product table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Product" (
  "id"                              TEXT        NOT NULL,
  "satsrailProductId"               TEXT        NOT NULL,
  "keyFingerprint"                  TEXT,
  "channelId"                       TEXT,
  "mediaId"                         TEXT,
  "productName"                     TEXT,
  "productPriceCents"               INTEGER,
  "productCurrency"                 TEXT,
  "productAccessDurationSeconds"    INTEGER,
  "productStatus"                   TEXT        DEFAULT 'active',
  "productSlug"                     TEXT,
  "productExternalRef"              TEXT,
  "syncedAt"                        TIMESTAMP(3),
  "createdAt"                       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Product_satsrailProductId_key" ON "Product"("satsrailProductId");
CREATE UNIQUE INDEX IF NOT EXISTS "Product_mediaId_key"           ON "Product"("mediaId");
CREATE INDEX        IF NOT EXISTS "Product_channelId_productStatus_idx"
  ON "Product"("channelId", "productStatus");
CREATE INDEX        IF NOT EXISTS "Product_productStatus_idx"     ON "Product"("productStatus");
CREATE INDEX        IF NOT EXISTS "Product_productExternalRef_idx" ON "Product"("productExternalRef");

-- Exactly one of channelId / mediaId is set. (NULL <> NULL is NULL, not TRUE,
-- so the check rejects the both-null case. Both-set evaluates FALSE.)
ALTER TABLE "Product"
  DROP CONSTRAINT IF EXISTS "Product_scope_exactly_one";
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_scope_exactly_one"
  CHECK (("channelId" IS NULL) <> ("mediaId" IS NULL));

-- ── 2. New MediaEncryptedBlob table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "MediaEncryptedBlob" (
  "id"                  TEXT        NOT NULL,
  "productId"           TEXT        NOT NULL,
  "mediaId"             TEXT        NOT NULL,
  "encryptedSourceUrl"  TEXT        NOT NULL,
  "keyFingerprint"      TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MediaEncryptedBlob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MediaEncryptedBlob_productId_mediaId_key"
  ON "MediaEncryptedBlob"("productId", "mediaId");
CREATE INDEX IF NOT EXISTS "MediaEncryptedBlob_mediaId_idx"   ON "MediaEncryptedBlob"("mediaId");
CREATE INDEX IF NOT EXISTS "MediaEncryptedBlob_productId_idx" ON "MediaEncryptedBlob"("productId");

-- ── 3. Media.blob JSONB column ──────────────────────────────────────────────

ALTER TABLE "Media" ADD COLUMN IF NOT EXISTS "blob" JSONB;

-- ── 4. Backfill Product from legacy MediaProduct (media-scoped) ─────────────
--
-- Only runs if the legacy table exists. PL/pgSQL block is used so that the
-- legacy-table lookups are skipped entirely on fresh installs.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'MediaProduct') THEN
    INSERT INTO "Product" (
      "id", "satsrailProductId", "keyFingerprint", "mediaId",
      "productName", "productPriceCents", "productCurrency",
      "productAccessDurationSeconds", "productStatus", "productSlug",
      "productExternalRef", "syncedAt", "createdAt", "updatedAt"
    )
    SELECT
      "id", "satsrailProductId", "keyFingerprint", "mediaId",
      "productName", "productPriceCents", "productCurrency",
      "productAccessDurationSeconds", "productStatus", "productSlug",
      "productExternalRef", "syncedAt", "createdAt", "updatedAt"
    FROM "MediaProduct"
    ON CONFLICT ("id") DO NOTHING;

    INSERT INTO "MediaEncryptedBlob" (
      "id", "productId", "mediaId", "encryptedSourceUrl", "keyFingerprint",
      "createdAt", "updatedAt"
    )
    SELECT
      gen_random_uuid()::TEXT,
      "id",
      "mediaId",
      "encryptedSourceUrl",
      "keyFingerprint",
      "createdAt",
      "updatedAt"
    FROM "MediaProduct"
    ON CONFLICT ("productId", "mediaId") DO NOTHING;
  END IF;
END $$;

-- ── 5. Backfill Product from legacy ChannelProduct (channel-scoped) ─────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ChannelProduct') THEN
    INSERT INTO "Product" (
      "id", "satsrailProductId", "keyFingerprint", "channelId",
      "productName", "productPriceCents", "productCurrency",
      "productAccessDurationSeconds", "productStatus", "productSlug",
      "productExternalRef", "syncedAt", "createdAt", "updatedAt"
    )
    SELECT
      "id", "satsrailProductId", "keyFingerprint", "channelId",
      "productName", "productPriceCents", "productCurrency",
      "productAccessDurationSeconds", "productStatus", "productSlug",
      "productExternalRef", "syncedAt", "createdAt", "updatedAt"
    FROM "ChannelProduct"
    ON CONFLICT ("id") DO NOTHING;
  END IF;
END $$;

-- ── 6. Backfill MediaEncryptedBlob from legacy ChannelProductMedia ──────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ChannelProductMedia') THEN
    INSERT INTO "MediaEncryptedBlob" (
      "id", "productId", "mediaId", "encryptedSourceUrl", "keyFingerprint",
      "createdAt", "updatedAt"
    )
    SELECT
      "id",
      "channelProductId",
      "mediaId",
      "encryptedSourceUrl",
      "keyFingerprint",
      "createdAt",
      "updatedAt"
    FROM "ChannelProductMedia"
    ON CONFLICT ("productId", "mediaId") DO NOTHING;
  END IF;
END $$;

-- ── 7. Backfill Media.blob from legacy sourceUrl + encryptedDek + mediaType ─

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Media' AND column_name = 'sourceUrl'
  ) THEN
    UPDATE "Media" m
    SET "blob" = CASE m."mediaType"::TEXT
      WHEN 'article' THEN jsonb_build_object('kind', 'markdown', 'body', m."sourceUrl")
      WHEN 'photo'   THEN jsonb_build_object(
        'kind',         'photo',
        'blobId',       m."sourceUrl",
        'encryptedDek', m."encryptedDek",
        'mimeType',     COALESCE(
          (SELECT b."mimeType" FROM "EncryptedPhotoBlob" b WHERE b."id" = m."sourceUrl"),
          'application/octet-stream'
        )
      )
      ELSE jsonb_build_object('kind', 'url', 'url', m."sourceUrl")
    END
    WHERE m."blob" IS NULL;
  END IF;
END $$;

-- ── 8. Enforce NOT NULL on Media.blob now that backfill is complete ─────────

ALTER TABLE "Media" ALTER COLUMN "blob" SET NOT NULL;

-- ── 9. FKs for the new tables ───────────────────────────────────────────────

ALTER TABLE "Product"
  DROP CONSTRAINT IF EXISTS "Product_channelId_fkey",
  ADD CONSTRAINT "Product_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "Channel"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Product"
  DROP CONSTRAINT IF EXISTS "Product_mediaId_fkey",
  ADD CONSTRAINT "Product_mediaId_fkey"
    FOREIGN KEY ("mediaId") REFERENCES "Media"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MediaEncryptedBlob"
  DROP CONSTRAINT IF EXISTS "MediaEncryptedBlob_productId_fkey",
  ADD CONSTRAINT "MediaEncryptedBlob_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MediaEncryptedBlob"
  DROP CONSTRAINT IF EXISTS "MediaEncryptedBlob_mediaId_fkey",
  ADD CONSTRAINT "MediaEncryptedBlob_mediaId_fkey"
    FOREIGN KEY ("mediaId") REFERENCES "Media"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 10. Drop legacy tables and columns ──────────────────────────────────────
--
-- Done in one shot since this is a pre-launch codebase (mid Mongo→Postgres
-- migration; no production Postgres data to protect across phases). If
-- production data ever lands before this migration runs, split steps 10a/10b
-- into a separate follow-up migration that runs after a burn-in period.

DROP TABLE IF EXISTS "ChannelProductMedia";
DROP TABLE IF EXISTS "ChannelProduct";
DROP TABLE IF EXISTS "MediaProduct";

-- PreviewImage was effectively unused (the upload shim writes to
-- EncryptedPhotoBlob; the lookup at GET /api/images/[id] kept a fallback that
-- never resolved any rows). Drop it as part of the same simplification.
DROP TABLE IF EXISTS "PreviewImage";

-- Counter was an atomic sequence generator for human-readable refs
-- (channel/media). Replaced by native Postgres sequences via Prisma's
-- @default(autoincrement()) on Channel.ref / Media.ref. Sequence names
-- are lowercase to match `prisma db push` (Prisma emits `SERIAL` which
-- Postgres auto-names without case-folding).
DROP TABLE IF EXISTS "Counter";

CREATE SEQUENCE IF NOT EXISTS channel_ref_seq START WITH 1;
CREATE SEQUENCE IF NOT EXISTS media_ref_seq   START WITH 1;
ALTER TABLE "Channel" ALTER COLUMN "ref" SET DEFAULT nextval('channel_ref_seq');
ALTER TABLE "Media"   ALTER COLUMN "ref" SET DEFAULT nextval('media_ref_seq');
ALTER SEQUENCE channel_ref_seq OWNED BY "Channel"."ref";
ALTER SEQUENCE media_ref_seq   OWNED BY "Media"."ref";

ALTER TABLE "Media" DROP COLUMN IF EXISTS "sourceUrl";
ALTER TABLE "Media" DROP COLUMN IF EXISTS "encryptedDek";

COMMIT;
