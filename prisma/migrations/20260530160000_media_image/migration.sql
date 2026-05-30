-- Unify media images: rename PreviewImage → MediaImage and absorb the inline
-- Media thumbnail columns + previewImageUrls into typed (kind) rows that carry
-- a proper FK to Media.
--
--   1. Rename the table (preserves ids, so existing /api/images/<id> URLs keep
--      resolving) and extend it with mediaId / kind / externalUrl / position.
--   2. A row is byte-backed (bytes + mimeType) OR url-backed (externalUrl) —
--      never both. Enforced by the MediaImage_oneof_source CHECK + app validation.
--   3. Backfill: link existing byte rows to their Media by matching the old
--      /api/images/<id> pointer, then insert rows for inline thumbnailBytes and
--      any external thumbnail / preview URLs (imports store direct URLs).
--   4. Drop the now-migrated Media columns.
--
-- Data-preserving and atomic. See plan:
-- /Users/rafael/.claude/plans/privapaid-previewimage-needs-to-elegant-dongarra.md

BEGIN;

-- 1. Rename the table + its primary key, then extend it. ----------------------
ALTER TABLE "PreviewImage" RENAME TO "MediaImage";
ALTER TABLE "MediaImage" RENAME CONSTRAINT "PreviewImage_pkey" TO "MediaImage_pkey";

CREATE TYPE "MediaImageKind" AS ENUM ('thumbnail', 'preview');

ALTER TABLE "MediaImage"
  ADD COLUMN   "mediaId"     TEXT,
  ADD COLUMN   "kind"        "MediaImageKind" NOT NULL DEFAULT 'preview',
  ADD COLUMN   "externalUrl" TEXT,
  ADD COLUMN   "position"    INTEGER NOT NULL DEFAULT 0,
  ALTER COLUMN "bytes"    DROP NOT NULL,
  ALTER COLUMN "mimeType" DROP NOT NULL;

ALTER TABLE "MediaImage" ADD CONSTRAINT "MediaImage_mediaId_fkey"
  FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "MediaImage_mediaId_kind_position_idx"
  ON "MediaImage"("mediaId", "kind", "position");

-- Exactly one source: byte-backed (bytes set, no externalUrl) XOR url-backed.
-- The renamed rows are all byte-backed, so they satisfy this immediately.
ALTER TABLE "MediaImage" ADD CONSTRAINT "MediaImage_oneof_source"
  CHECK (
    ("bytes" IS NOT NULL AND "externalUrl" IS NULL)
    OR ("bytes" IS NULL AND "externalUrl" IS NOT NULL)
  );

-- 2. Backfill from the Media columns we're about to drop. ---------------------

-- 2a. Existing rows pointed at by Media.thumbnailUrl (internal /api/images/<id>).
UPDATE "MediaImage" mi
SET "mediaId" = m."id", "kind" = 'thumbnail', "position" = 0
FROM "Media" m
WHERE m."thumbnailUrl" = '/api/images/' || mi."id";

-- 2b. Existing rows referenced in Media.previewImageUrls (ordinality → position).
UPDATE "MediaImage" mi
SET "mediaId" = m."id", "kind" = 'preview', "position" = pu.ord - 1
FROM "Media" m, LATERAL unnest(m."previewImageUrls") WITH ORDINALITY pu(url, ord)
WHERE pu.url = '/api/images/' || mi."id";

-- 2c. Inline Media.thumbnailBytes → a new byte-backed thumbnail row, but only
--     when nothing was linked as a thumbnail in 2a (bytes win over external URL).
INSERT INTO "MediaImage" ("id", "mediaId", "kind", "bytes", "mimeType", "position", "createdAt")
SELECT gen_random_uuid()::text, m."id", 'thumbnail', m."thumbnailBytes", m."thumbnailMimeType", 0, CURRENT_TIMESTAMP
FROM "Media" m
WHERE m."thumbnailBytes" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "MediaImage" x WHERE x."mediaId" = m."id" AND x."kind" = 'thumbnail'
  );

-- 2d. External Media.thumbnailUrl → a new url-backed thumbnail row, only when no
--     thumbnail (linked or inline) exists yet for this media.
INSERT INTO "MediaImage" ("id", "mediaId", "kind", "externalUrl", "position", "createdAt")
SELECT gen_random_uuid()::text, m."id", 'thumbnail', m."thumbnailUrl", 0, CURRENT_TIMESTAMP
FROM "Media" m
WHERE m."thumbnailUrl" <> ''
  AND m."thumbnailUrl" NOT LIKE '/api/images/%'
  AND NOT EXISTS (
    SELECT 1 FROM "MediaImage" x WHERE x."mediaId" = m."id" AND x."kind" = 'thumbnail'
  );

-- 2e. External Media.previewImageUrls entries → new url-backed preview rows.
INSERT INTO "MediaImage" ("id", "mediaId", "kind", "externalUrl", "position", "createdAt")
SELECT gen_random_uuid()::text, m."id", 'preview', pu.url, pu.ord - 1, CURRENT_TIMESTAMP
FROM "Media" m, LATERAL unnest(m."previewImageUrls") WITH ORDINALITY pu(url, ord)
WHERE pu.url <> ''
  AND pu.url NOT LIKE '/api/images/%';

-- 3. Contract: drop the now-migrated Media columns. ---------------------------
ALTER TABLE "Media"
  DROP COLUMN "thumbnailUrl",
  DROP COLUMN "thumbnailBytes",
  DROP COLUMN "thumbnailMimeType",
  DROP COLUMN "previewImageUrls";

COMMIT;
