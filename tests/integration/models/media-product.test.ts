import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel, createMedia, createMediaProduct } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

/**
 * Media-scoped product (1:1 with Media): one Product row + one
 * MediaEncryptedBlob row, written via the `createMediaProduct` helper.
 *
 * These tests exercise the same invariants the legacy `MediaProduct` model
 * carried — mediaId uniqueness, encryptedSource persistence, the
 * keyFingerprint field — but against the new split shape.
 */
describe("Product + MediaEncryptedBlob (media-scoped)", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates a media-scoped product with required fields", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);

    const product = await createMediaProduct({
      mediaId: media.id,
      satsrailProductId: "prod_test_123",
      encryptedSource: "base64encryptedblob==",
    });

    expect(product.mediaId).toBe(media.id);
    expect(product.satsrailProductId).toBe("prod_test_123");
    expect(product.createdAt).toBeInstanceOf(Date);

    const blob = await prisma.mediaEncryptedBlob.findFirst({
      where: { productId: product.id, mediaId: media.id },
    });
    expect(blob).not.toBeNull();
    expect(blob!.encryptedSource).toBe("base64encryptedblob==");
  });

  it("stores keyFingerprint on Product and blob", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);

    const product = await createMediaProduct({
      mediaId: media.id,
      satsrailProductId: "prod_fp_123",
      encryptedSource: "blob==",
      keyFingerprint: "sha256hexfingerprint",
    });

    expect(product.keyFingerprint).toBe("sha256hexfingerprint");
    const blob = await prisma.mediaEncryptedBlob.findFirst({
      where: { productId: product.id },
    });
    expect(blob!.keyFingerprint).toBe("sha256hexfingerprint");
  });

  it("enforces mediaId uniqueness on Product", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);

    await createMediaProduct({
      mediaId: media.id,
      satsrailProductId: "prod_1",
      encryptedSource: "blob1==",
    });

    await expect(
      createMediaProduct({
        mediaId: media.id,
        satsrailProductId: "prod_2",
        encryptedSource: "blob2==",
      })
    ).rejects.toThrow();
  });

  it("updates encryptedSource on the blob (re-encryption simulation)", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);

    const product = await createMediaProduct({
      mediaId: media.id,
      satsrailProductId: "prod_reencrypt",
      encryptedSource: "old_blob==",
      keyFingerprint: "old_fp",
    });

    await prisma.mediaEncryptedBlob.updateMany({
      where: { productId: product.id },
      data: { encryptedSource: "new_blob==", keyFingerprint: "new_fp" },
    });

    const blob = await prisma.mediaEncryptedBlob.findFirst({
      where: { productId: product.id },
    });
    expect(blob!.encryptedSource).toBe("new_blob==");
    expect(blob!.keyFingerprint).toBe("new_fp");
  });
});
