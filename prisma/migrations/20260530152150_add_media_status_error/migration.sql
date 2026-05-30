-- Media error-state flag (Part B): mark content that genuinely fails to decrypt
-- so admins can find and fix it, and the viewer can stop hitting the SatsRail
-- portal for an asset that will only fail to decrypt anyway.
--
--   status          'ok' (default) | 'error' — server-confirmed integrity failure
--   statusReason    last allowlisted failure code (no free-text ever stored)
--   statusChangedAt when the flag last flipped
--
-- The composite index backs the admin "flagged media" filter (channelId, status).

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('ok', 'error');

-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "status" "MediaStatus" NOT NULL DEFAULT 'ok',
ADD COLUMN     "statusChangedAt" TIMESTAMP(3),
ADD COLUMN     "statusReason" TEXT;

-- CreateIndex
CREATE INDEX "Media_channelId_status_idx" ON "Media"("channelId", "status");
