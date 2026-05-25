import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

let refCounter = 1000;

export async function createCategory(overrides: Partial<{
  name: string;
  slug: string;
  position: number;
  active: boolean;
}> = {}) {
  return prisma.category.create({
    data: {
      name: "Test Category",
      slug: `test-category-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      position: 0,
      active: true,
      ...overrides,
    },
  });
}

export async function createChannel(overrides: Partial<{
  name: string;
  slug: string;
  bio: string;
  active: boolean;
  ref: number;
  categoryId: string | null;
  satsrailProductTypeId: string | null;
}> = {}) {
  refCounter++;
  return prisma.channel.create({
    data: {
      ref: refCounter,
      name: "Test Channel",
      slug: `test-channel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      bio: "A test channel",
      active: true,
      ...overrides,
    },
  });
}

export async function createCustomer(
  overrides: Partial<{
    nickname: string;
    passwordHash: string;
    password: string;
  }> = {}
) {
  const password = overrides.password || "TestPass123!@";
  const rest = { ...overrides };
  delete rest.password;
  return prisma.customer.create({
    data: {
      nickname: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      passwordHash: await bcrypt.hash(password, 4),
      ...rest,
    },
  });
}

export async function createMedia(
  channelId: string,
  overrides: Partial<{
    name: string;
    sourceUrl: string;
    mediaType: "video" | "audio" | "article" | "photo" | "podcast";
    ref: number;
    description: string;
    position: number;
  }> = {}
) {
  refCounter++;
  return prisma.media.create({
    data: {
      ref: refCounter,
      channelId,
      name: "Test Media",
      sourceUrl: "https://example.com/video.mp4",
      mediaType: "video",
      ...overrides,
    },
  });
}

export async function createSettings(
  overrides: Partial<{
    instanceName: string;
    setupCompleted: boolean;
    merchantId: string | null;
    satsrailApiUrl: string;
    satsrailApiKeyEncrypted: string | null;
  }> = {}
) {
  return prisma.settings.upsert({
    where: { id: 1 },
    update: {
      instanceName: "Test Instance",
      setupCompleted: true,
      ...overrides,
    },
    create: {
      id: 1,
      instanceName: "Test Instance",
      setupCompleted: true,
      ...overrides,
    },
  });
}

export async function createWebhookEvent(
  overrides: Partial<{
    eventId: string;
    eventType: string;
  }> = {}
) {
  return prisma.webhookEvent.create({
    data: {
      eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      eventType: "test.event",
      ...overrides,
    },
  });
}
