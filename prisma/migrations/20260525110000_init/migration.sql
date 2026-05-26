-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('owner', 'admin', 'moderator');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('admin', 'system');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('video', 'audio', 'article', 'photo', 'podcast');

-- CreateTable
CREATE TABLE "Admin" (
    "id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'admin',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" CITEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "ref" SERIAL NOT NULL,
    "slug" CITEXT NOT NULL,
    "satsrailProductTypeId" TEXT,
    "name" TEXT NOT NULL,
    "bio" TEXT NOT NULL DEFAULT '',
    "categoryId" TEXT,
    "nsfw" BOOLEAN NOT NULL DEFAULT false,
    "socialLinks" JSONB NOT NULL DEFAULT '{}',
    "profileImageUrl" TEXT NOT NULL DEFAULT '',
    "profileImageBytes" BYTEA,
    "profileImageMimeType" TEXT,
    "isLive" BOOLEAN NOT NULL DEFAULT false,
    "streamUrl" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mediaCount" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Media" (
    "id" TEXT NOT NULL,
    "ref" SERIAL NOT NULL,
    "channelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "mediaType" "MediaType" NOT NULL DEFAULT 'video',
    "blob" JSONB NOT NULL,
    "thumbnailUrl" TEXT NOT NULL DEFAULT '',
    "thumbnailBytes" BYTEA,
    "thumbnailMimeType" TEXT,
    "previewImageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "viewsCount" INTEGER NOT NULL DEFAULT 0,
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "sharesCount" INTEGER NOT NULL DEFAULT 0,
    "commentsCount" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EncryptedPhotoBlob" (
    "id" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EncryptedPhotoBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "satsrailProductId" TEXT NOT NULL,
    "keyFingerprint" TEXT,
    "channelId" TEXT,
    "mediaId" TEXT,
    "productName" TEXT,
    "productPriceCents" INTEGER,
    "productCurrency" TEXT,
    "productAccessDurationSeconds" INTEGER,
    "productStatus" TEXT DEFAULT 'active',
    "productSlug" TEXT,
    "productExternalRef" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaEncryptedBlob" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "encryptedSourceUrl" TEXT NOT NULL,
    "keyFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaEncryptedBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "setupCompleted" BOOLEAN NOT NULL DEFAULT false,
    "setupCompletedAt" TIMESTAMP(3),
    "instanceName" TEXT NOT NULL,
    "instanceDomain" TEXT NOT NULL DEFAULT 'localhost:3000',
    "nsfwEnabled" BOOLEAN NOT NULL DEFAULT false,
    "adultDisclaimer" TEXT NOT NULL DEFAULT '',
    "themePrimary" TEXT NOT NULL DEFAULT '#3b82f6',
    "themeBg" TEXT NOT NULL DEFAULT '#0a0a0a',
    "themeBgSecondary" TEXT NOT NULL DEFAULT '#18181b',
    "themeText" TEXT NOT NULL DEFAULT '#ededed',
    "themeTextSecondary" TEXT NOT NULL DEFAULT '#a1a1aa',
    "themeHeading" TEXT NOT NULL DEFAULT '#fafafa',
    "themeBorder" TEXT NOT NULL DEFAULT '#27272a',
    "themeFont" TEXT NOT NULL DEFAULT 'Geist',
    "logoUrl" TEXT NOT NULL DEFAULT '',
    "logoBytes" BYTEA,
    "logoMimeType" TEXT,
    "aboutText" TEXT NOT NULL DEFAULT '',
    "satsrailApiUrl" TEXT NOT NULL DEFAULT 'https://satsrail.com/api/v1',
    "satsrailApiKeyEncrypted" TEXT,
    "merchantId" TEXT,
    "merchantName" TEXT,
    "merchantCurrency" TEXT NOT NULL DEFAULT 'USD',
    "merchantLocale" TEXT NOT NULL DEFAULT 'en',
    "googleAnalyticsId" TEXT NOT NULL DEFAULT '',
    "googleSiteVerification" TEXT NOT NULL DEFAULT '',
    "sentryDsn" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL DEFAULT '',
    "actorType" "AuditActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL DEFAULT '',
    "targetId" TEXT NOT NULL DEFAULT '',
    "details" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Admin_email_key" ON "Admin"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE INDEX "Category_position_idx" ON "Category"("position");

-- CreateIndex
CREATE INDEX "Category_active_idx" ON "Category"("active");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_ref_key" ON "Channel"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_slug_key" ON "Channel"("slug");

-- CreateIndex
CREATE INDEX "Channel_categoryId_idx" ON "Channel"("categoryId");

-- CreateIndex
CREATE INDEX "Channel_active_idx" ON "Channel"("active");

-- CreateIndex
CREATE INDEX "Channel_createdAt_idx" ON "Channel"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Media_ref_key" ON "Media"("ref");

-- CreateIndex
CREATE INDEX "Media_channelId_position_idx" ON "Media"("channelId", "position");

-- CreateIndex
CREATE INDEX "Media_channelId_viewsCount_idx" ON "Media"("channelId", "viewsCount" DESC);

-- CreateIndex
CREATE INDEX "Media_createdAt_idx" ON "Media"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Product_satsrailProductId_key" ON "Product"("satsrailProductId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_mediaId_key" ON "Product"("mediaId");

-- CreateIndex
CREATE INDEX "Product_channelId_productStatus_idx" ON "Product"("channelId", "productStatus");

-- CreateIndex
CREATE INDEX "Product_productStatus_idx" ON "Product"("productStatus");

-- CreateIndex
CREATE INDEX "Product_productExternalRef_idx" ON "Product"("productExternalRef");

-- CreateIndex
CREATE INDEX "MediaEncryptedBlob_mediaId_idx" ON "MediaEncryptedBlob"("mediaId");

-- CreateIndex
CREATE INDEX "MediaEncryptedBlob_productId_idx" ON "MediaEncryptedBlob"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaEncryptedBlob_productId_mediaId_key" ON "MediaEncryptedBlob"("productId", "mediaId");

-- CreateIndex
CREATE INDEX "Comment_mediaId_createdAt_idx" ON "Comment"("mediaId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_eventId_key" ON "WebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_idx" ON "WebhookEvent"("processedAt");

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaEncryptedBlob" ADD CONSTRAINT "MediaEncryptedBlob_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaEncryptedBlob" ADD CONSTRAINT "MediaEncryptedBlob_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Check constraint: Product must be scoped to exactly one of channel or media ──
-- Not emitted by `prisma migrate diff` because Prisma can't express CHECK
-- constraints in the schema. (NULL <> NULL is NULL, not TRUE, so this rejects
-- the both-null case; both-set evaluates FALSE.)
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_scope_exactly_one"
  CHECK (("channelId" IS NULL) <> ("mediaId" IS NULL));
