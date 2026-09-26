-- CreateEnum
CREATE TYPE "VideoVersionStatus" AS ENUM ('uploading', 'queued', 'processing', 'ready', 'failed', 'cancelled', 'deleting', 'deleted');

-- CreateEnum
CREATE TYPE "VideoStorageProvider" AS ENUM ('local', 's3');

-- CreateEnum
CREATE TYPE "VideoUploadStatus" AS ENUM ('open', 'completed', 'aborted');

-- CreateEnum
CREATE TYPE "VideoJobKind" AS ENUM ('storage_probe', 'package_asset');

-- CreateEnum
CREATE TYPE "VideoJobStatus" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "VideoAsset" (
    "id" UUID NOT NULL,
    "mediaId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "publishedVersionId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoAssetVersion" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "status" "VideoVersionStatus" NOT NULL DEFAULT 'uploading',
    "provider" "VideoStorageProvider" NOT NULL,
    "storagePrefix" VARCHAR(240) NOT NULL,
    "wrappedRootKey" VARCHAR(256) NOT NULL,
    "formatVersion" INTEGER NOT NULL,
    "encodingProfile" VARCHAR(64) NOT NULL,
    "segmentSeconds" INTEGER NOT NULL,
    "manifestKey" VARCHAR(512),
    "manifestSha256" CHAR(64),
    "objectCount" INTEGER NOT NULL DEFAULT 0,
    "encryptedBytes" BIGINT NOT NULL DEFAULT 0,
    "durationMs" BIGINT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "readyAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "VideoAssetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoUploadSession" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "ownerId" VARCHAR(128) NOT NULL,
    "status" "VideoUploadStatus" NOT NULL DEFAULT 'open',
    "expectedBytes" BIGINT NOT NULL,
    "receivedBytes" BIGINT NOT NULL DEFAULT 0,
    "sourceSha256" CHAR(64),
    "providerUploadId" VARCHAR(2048),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VideoUploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoJob" (
    "id" UUID NOT NULL,
    "kind" "VideoJobKind" NOT NULL,
    "versionId" UUID,
    "idempotencyKey" VARCHAR(160) NOT NULL,
    "status" "VideoJobStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VideoJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoWorker" (
    "storageIdentity" CHAR(64) NOT NULL,
    "id" UUID NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoWorker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoAsset_mediaId_key" ON "VideoAsset"("mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoAsset_id_publishedVersionId_key" ON "VideoAsset"("id", "publishedVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoAssetVersion_storagePrefix_key" ON "VideoAssetVersion"("storagePrefix");

-- CreateIndex
CREATE INDEX "VideoAssetVersion_status_createdAt_idx" ON "VideoAssetVersion"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VideoAssetVersion_assetId_id_key" ON "VideoAssetVersion"("assetId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "VideoAssetVersion_assetId_generation_key" ON "VideoAssetVersion"("assetId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "VideoUploadSession_versionId_key" ON "VideoUploadSession"("versionId");

-- CreateIndex
CREATE INDEX "VideoUploadSession_status_expiresAt_idx" ON "VideoUploadSession"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "VideoJob_versionId_key" ON "VideoJob"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoJob_idempotencyKey_key" ON "VideoJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "VideoJob_status_availableAt_idx" ON "VideoJob"("status", "availableAt");

-- CreateIndex
CREATE INDEX "VideoJob_status_leaseExpiresAt_idx" ON "VideoJob"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "VideoWorker_lastSeenAt_idx" ON "VideoWorker"("lastSeenAt");

-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_id_publishedVersionId_fkey" FOREIGN KEY ("id", "publishedVersionId") REFERENCES "VideoAssetVersion"("assetId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "VideoAssetVersion" ADD CONSTRAINT "VideoAssetVersion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "VideoAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoUploadSession" ADD CONSTRAINT "VideoUploadSession_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "VideoAssetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoJob" ADD CONSTRAINT "VideoJob_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "VideoAssetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Bounded metadata, legal counters and lease shape. No media bytes in these tables.
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_generation_check" CHECK (generation >= 0);
ALTER TABLE "VideoAssetVersion" ADD CONSTRAINT "VideoVersion_bounds_check" CHECK (
  generation > 0 AND "formatVersion" >= 0 AND "segmentSeconds" IN (4, 10)
  AND progress BETWEEN 0 AND 100 AND "objectCount" BETWEEN 0 AND 100000
  AND "encryptedBytes" BETWEEN 0 AND 107374182400
  AND ("durationMs" IS NULL OR "durationMs" BETWEEN 1 AND 86400000)
  AND ("manifestSha256" IS NULL OR "manifestSha256" ~ '^[a-f0-9]{64}$')
  AND (status <> 'ready' OR ("manifestKey" IS NOT NULL AND "manifestSha256" IS NOT NULL
    AND "readyAt" IS NOT NULL AND progress = 100 AND "objectCount" > 0 AND "encryptedBytes" > 0 AND "durationMs" IS NOT NULL))
);
ALTER TABLE "VideoUploadSession" ADD CONSTRAINT "VideoUpload_bounds_check" CHECK (
  "expectedBytes" BETWEEN 1 AND 10737418240 AND "receivedBytes" BETWEEN 0 AND "expectedBytes"
  AND ("sourceSha256" IS NULL OR "sourceSha256" ~ '^[a-f0-9]{64}$')
);
ALTER TABLE "VideoJob" ADD CONSTRAINT "VideoJob_bounds_check" CHECK (
  attempts BETWEEN 0 AND "maxAttempts" AND "maxAttempts" BETWEEN 1 AND 10
  AND ((status = 'running' AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
    OR (status <> 'running' AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL))
  AND ((kind = 'package_asset' AND "versionId" IS NOT NULL) OR (kind = 'storage_probe' AND "versionId" IS NULL))
);
