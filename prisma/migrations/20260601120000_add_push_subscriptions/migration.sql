-- Anonymous Web Push subscriptions: one row per (browser endpoint x channel).
-- See prisma/schema.prisma `PushSubscription` for the full rationale. Additive
-- and non-destructive — creates a new table only.

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PushSubscription_channelId_idx" ON "PushSubscription"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_channelId_endpoint_key" ON "PushSubscription"("channelId", "endpoint");

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
