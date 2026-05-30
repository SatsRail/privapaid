import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel, createMedia, createChannelProduct } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

/**
 * Channel-scoped product (bundle): one Product row (channelId set) + N
 * MediaProduct rows. Asserts the same invariants the legacy
 * `ChannelProduct` model carried — satsrailProductId uniqueness, encrypted
 * media linkage, cached portal fields — against the new shape.
 */
describe("Product (channel-scoped) + MediaProduct", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates a channel-scoped product with required fields", async () => {
    const channel = await createChannel();
    const cp = await createChannelProduct({
      channelId: channel.id,
      satsrailProductId: "prod_abc123",
    });
    expect(cp.id).toBeDefined();
    expect(cp.channelId).toBe(channel.id);
    expect(cp.satsrailProductId).toBe("prod_abc123");
  });

  it("sets default values", async () => {
    const channel = await createChannel();
    const cp = await createChannelProduct({
      channelId: channel.id,
      satsrailProductId: "prod_defaults",
    });
    const blobs = await prisma.mediaProduct.findMany({
      where: { productId: cp.id },
    });
    expect(blobs).toEqual([]);
    expect(cp.keyFingerprint).toBeNull();
    expect(cp.productName).toBeNull();
    expect(cp.syncedAt).toBeNull();
  });

  it("creates timestamps", async () => {
    const channel = await createChannel();
    const cp = await createChannelProduct({
      channelId: channel.id,
      satsrailProductId: "prod_ts",
    });
    expect(cp.createdAt).toBeInstanceOf(Date);
    expect(cp.updatedAt).toBeInstanceOf(Date);
  });

  it("enforces satsrailProductId uniqueness", async () => {
    const channel = await createChannel();
    await createChannelProduct({
      channelId: channel.id,
      satsrailProductId: "prod_unique",
    });
    await expect(
      createChannelProduct({
        channelId: channel.id,
        satsrailProductId: "prod_unique",
      })
    ).rejects.toThrow();
  });

  it("stores encrypted media entries as MediaProduct rows", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    const cp = await createChannelProduct({
      channelId: channel.id,
      satsrailProductId: "prod_media",
      encryptedMedia: [{ mediaId: media.id, encryptedSource: "base64_encrypted_blob" }],
    });
    const blobs = await prisma.mediaProduct.findMany({
      where: { productId: cp.id },
    });
    expect(blobs).toHaveLength(1);
    expect(blobs[0].mediaId).toBe(media.id);
    expect(blobs[0].encryptedDek).toBe("base64_encrypted_blob");
  });

  it("stores cached product metadata", async () => {
    const channel = await createChannel();
    const cp = await createChannelProduct({
      channelId: channel.id,
      satsrailProductId: "prod_meta",
      productName: "Premium Video",
      productPriceCents: 5000,
      productCurrency: "USD",
      productAccessDurationSeconds: 86400,
      productStatus: "active",
      productSlug: "premium-video",
      syncedAt: new Date(),
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
    const cp = await createChannelProduct({
      channelId: channel.id,
      satsrailProductId: "prod_fp",
      keyFingerprint: fingerprint,
    });
    expect(cp.keyFingerprint).toBe(fingerprint);
  });

  it("queries by channelId", async () => {
    const ch1 = await createChannel({ slug: "ch-one" });
    const ch2 = await createChannel({ slug: "ch-two" });
    await createChannelProduct({ channelId: ch1.id, satsrailProductId: "prod_ch1" });
    await createChannelProduct({ channelId: ch2.id, satsrailProductId: "prod_ch2" });
    const results = await prisma.product.findMany({ where: { channelId: ch1.id } });
    expect(results).toHaveLength(1);
    expect(results[0].satsrailProductId).toBe("prod_ch1");
  });
});
