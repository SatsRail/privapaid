-- AlterTable
ALTER TABLE "VideoAssetVersion" ADD COLUMN     "cleanupExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "cleanupToken" UUID,
ADD COLUMN     "encryptedDescriptor" BYTEA,
ADD COLUMN     "reservedBytes" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "sourceCleanedAt" TIMESTAMPTZ(3),
ADD COLUMN     "storageIdentity" CHAR(64);

-- AlterTable
ALTER TABLE "VideoUploadSession" ADD COLUMN     "bindingFingerprint" CHAR(64),
ADD COLUMN     "clientFingerprint" CHAR(64),
ADD COLUMN     "envelopeId" TEXT,
ADD COLUMN     "envelopeKeyFingerprint" CHAR(64),
ADD COLUMN     "idempotencyKey" UUID,
ADD COLUMN     "partBytes" INTEGER NOT NULL DEFAULT 8388608,
ADD COLUMN     "productFingerprint" CHAR(64),
ADD COLUMN     "productId" TEXT,
ADD COLUMN     "requestExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "requestToken" UUID;

-- AlterTable
ALTER TABLE "VideoJob" ADD COLUMN     "scope" CHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "VideoUploadSession_idempotencyKey_key" ON "VideoUploadSession"("idempotencyKey");

-- CreateIndex
CREATE INDEX "VideoJob_scope_status_availableAt_idx" ON "VideoJob"("scope", "status", "availableAt");


ALTER TABLE "VideoUploadSession" ADD CONSTRAINT "VideoUpload_ingestion_bounds" CHECK (
  "partBytes" = 8388608 AND ("clientFingerprint" IS NULL OR "clientFingerprint" ~ '^[a-f0-9]{64}$')
  AND (("requestToken" IS NULL AND "requestExpiresAt" IS NULL) OR ("requestToken" IS NOT NULL AND "requestExpiresAt" IS NOT NULL))
  AND ("idempotencyKey" IS NULL OR ("clientFingerprint" IS NOT NULL AND "productId" IS NOT NULL
    AND "productFingerprint" IS NOT NULL AND "bindingFingerprint" IS NOT NULL AND "envelopeId" IS NOT NULL AND "envelopeKeyFingerprint" IS NOT NULL))
);
ALTER TABLE "VideoAssetVersion" ADD CONSTRAINT "VideoVersion_ingestion_bounds" CHECK (
  "reservedBytes" BETWEEN 0 AND 107374182400
  AND ("encryptedDescriptor" IS NULL OR octet_length("encryptedDescriptor") BETWEEN 29 AND 16384)
  AND ("formatVersion" <> 1 OR ("storageIdentity" IS NOT NULL AND (status <> 'ready' OR "encryptedDescriptor" IS NOT NULL)))
);
