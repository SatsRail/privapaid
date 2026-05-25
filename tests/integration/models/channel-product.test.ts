import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel, createMedia } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

describe("ChannelProduct model", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates a channel product with required fields", async () => {
    const channel = await createChannel();
    const cp = await prisma.channelProduct.create({
      data: {
        channelId: channel.id,
        satsrailProductId: "prod_abc123",
      },
    });
    expect(cp.id).toBeDefined();
    expect(cp.channelId).toBe(channel.id);
    expect(cp.satsrailProductId).toBe("prod_abc123");
  });

  it("sets default values", async () => {
    const channel = await createChannel();
    const cp = await prisma.channelProduct.create({
      data: {
        channelId: channel.id,
        satsrailProductId: "prod_defaults",
      },
      include: { encryptedMedia: true },
    });
    expect(cp.encryptedMedia).toEqual([]);
    expect(cp.keyFingerprint).toBeNull();
    expect(cp.productName).toBeNull();
    expect(cp.syncedAt).toBeNull();
  });

  it("creates timestamps", async () => {
    const channel = await createChannel();
    const cp = await prisma.channelProduct.create({
      data: {
        channelId: channel.id,
        satsrailProductId: "prod_ts",
      },
    });
    expect(cp.createdAt).toBeInstanceOf(Date);
    expect(cp.updatedAt).toBeInstanceOf(Date);
  });

  it("enforces satsrailProductId uniqueness", async () => {
    const channel = await createChannel();
    await prisma.channelProduct.create({
      data: {
        channelId: channel.id,
        satsrailProductId: "prod_unique",
      },
    });
    await expect(
      prisma.channelProduct.create({
        data: {
          channelId: channel.id,
          satsrailProductId: "prod_unique",
        },
      })
    ).rejects.toThrow();
  });

  it("stores encrypted media entries", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    const cp = await prisma.channelProduct.create({
      data: {
        channelId: channel.id,
        satsrailProductId: "prod_media",
        encryptedMedia: {
          create: [{ mediaId: media.id, encryptedSourceUrl: "base64_encrypted_blob" }],
        },
      },
      include: { encryptedMedia: true },
    });
    expect(cp.encryptedMedia).toHaveLength(1);
    expect(cp.encryptedMedia[0].mediaId).toBe(media.id);
    expect(cp.encryptedMedia[0].encryptedSourceUrl).toBe("base64_encrypted_blob");
  });

  it("stores cached product metadata", async () => {
    const channel = await createChannel();
    const cp = await prisma.channelProduct.create({
      data: {
        channelId: channel.id,
        satsrailProductId: "prod_meta",
        productName: "Premium Video",
        productPriceCents: 5000,
        productCurrency: "USD",
        productAccessDurationSeconds: 86400,
        productStatus: "active",
        productSlug: "premium-video",
        syncedAt: new Date(),
      },
    });
    expect(cp.productName).toBe("Premium Video");
    expect(cp.productPriceCents).toBe(5000);
    expect(cp.productCurrency).toBe("USD");
    expect(cp.productAccessDurationSeconds).toBe(86400);
    expect(cp.productStatus).toBe("active");
    expect(cp.productSlug).toBe("premium-video");
    expect(cp.syncedAt).toBeInstanceOf(Date);
  });

  it("stores key fingerprint", async () => {
    const channel = await createChannel();
    const fingerprint = "a".repeat(64);
    const cp = await prisma.channelProduct.create({
      data: {
        channelId: channel.id,
        satsrailProductId: "prod_fp",
        keyFingerprint: fingerprint,
      },
    });
    expect(cp.keyFingerprint).toBe(fingerprint);
  });

  it("queries by channelId", async () => {
    const ch1 = await createChannel({ slug: "ch-one" });
    const ch2 = await createChannel({ slug: "ch-two" });
    await prisma.channelProduct.create({
      data: { channelId: ch1.id, satsrailProductId: "prod_ch1" },
    });
    await prisma.channelProduct.create({
      data: { channelId: ch2.id, satsrailProductId: "prod_ch2" },
    });
    const results = await prisma.channelProduct.findMany({ where: { channelId: ch1.id } });
    expect(results).toHaveLength(1);
    expect(results[0].satsrailProductId).toBe("prod_ch1");
  });
});
