import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel, createMedia } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

describe("MediaProduct model", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates a media product with required fields", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);

    const mp = await prisma.mediaProduct.create({
      data: {
        mediaId: media.id,
        satsrailProductId: "prod_test_123",
        encryptedSourceUrl: "base64encryptedblob==",
      },
    });

    expect(mp.mediaId).toBe(media.id);
    expect(mp.satsrailProductId).toBe("prod_test_123");
    expect(mp.encryptedSourceUrl).toBe("base64encryptedblob==");
    expect(mp.createdAt).toBeInstanceOf(Date);
  });

  it("stores keyFingerprint", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);

    const mp = await prisma.mediaProduct.create({
      data: {
        mediaId: media.id,
        satsrailProductId: "prod_fp_123",
        encryptedSourceUrl: "blob==",
        keyFingerprint: "sha256hexfingerprint",
      },
    });

    expect(mp.keyFingerprint).toBe("sha256hexfingerprint");
  });

  it("enforces mediaId uniqueness", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);

    await prisma.mediaProduct.create({
      data: {
        mediaId: media.id,
        satsrailProductId: "prod_1",
        encryptedSourceUrl: "blob1==",
      },
    });

    await expect(
      prisma.mediaProduct.create({
        data: {
          mediaId: media.id,
          satsrailProductId: "prod_2",
          encryptedSourceUrl: "blob2==",
        },
      })
    ).rejects.toThrow();
  });

  it("updates encryptedSourceUrl (re-encryption simulation)", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);

    const mp = await prisma.mediaProduct.create({
      data: {
        mediaId: media.id,
        satsrailProductId: "prod_reencrypt",
        encryptedSourceUrl: "old_blob==",
        keyFingerprint: "old_fp",
      },
    });

    const updated = await prisma.mediaProduct.update({
      where: { id: mp.id },
      data: { encryptedSourceUrl: "new_blob==", keyFingerprint: "new_fp" },
    });
    expect(updated.encryptedSourceUrl).toBe("new_blob==");
    expect(updated.keyFingerprint).toBe("new_fp");
  });
});
