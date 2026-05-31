import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct } from "../../helpers/factories";
import { mockSatsrailClient } from "../../helpers/mocks/satsrail";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { createEnvelopeArtifacts } from "@/lib/media-envelope";
import {
  base64urlToBytes,
  clientDecryptBlob,
  clientDecryptBytesWithKey,
  genProductKey,
} from "../../helpers/crypto";

/**
 * After the EncryptedEnvelope→MediaEnvelope migration, re-saving an envelope-less
 * url media mints a FRESH per-media DEK. The pre-existing MediaProduct rows still
 * wrap the OLD value, so a buyer recovers the wrong key and the viewer shows
 * "Payment received … couldn't unlock the content on this device".
 *
 * `reencryptMediaProductsForMedia` repairs that by re-wrapping each MediaProduct
 * under the envelope's CURRENT DEK (recovered from wrappedDek/CONTENT_KEK) using
 * the product's SatsRail key. This test exercises the REAL crypto end-to-end:
 * it asserts the two-step buyer decrypt (product key → DEK → envelope bytes)
 * recovers the content after the repair — the exact path that was broken.
 */

vi.mock("@/lib/satsrail", () => ({ satsrail: mockSatsrailClient }));

import { reencryptMediaProductsForMedia } from "@/lib/media-product-reencrypt";
import { prisma } from "@/lib/prisma";

let refSeed = 7000;
function nextRef(): number {
  refSeed += 1;
  return refSeed;
}

describe("reencryptMediaProductsForMedia → buyer can decrypt after a fresh envelope mint", () => {
  beforeAll(async () => {
    await setupTestDB();
  });
  afterAll(async () => {
    await teardownTestDB();
  });
  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
  });

  /**
   * Seed a freshly-minted envelope (new DEK) plus a STALE MediaProduct row that
   * wraps the wrong value — the post-migration broken state. Returns the real
   * DEK (base64url) so the test can prove the re-wrap targets the exact key.
   */
  async function seedRepairScenario(url: string, productId: string, productKey: string) {
    const art = createEnvelopeArtifacts(Buffer.from(url, "utf8"));
    const channel = await prisma.channel.create({
      data: { ref: nextRef(), slug: `rk-${nextRef()}`, name: "RK", active: true },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Re-keyed video",
        mediaType: "video",
        envelope: {
          create: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            bytes: art.bytes as any,
            mimeType: "text/url",
            wrappedDek: art.wrappedDek,
          },
        },
      },
    });
    const staleCiphertext = encryptSourceUrl("stale-pre-migration-value", productKey, productId);
    await createMediaProduct({
      mediaId: media.id,
      satsrailProductId: productId,
      encryptedSource: staleCiphertext,
    });
    return { mediaId: media.id, dekBase64url: art.dekBase64url };
  }

  it("re-wraps the stale row under the envelope's current DEK so the two-step decrypt yields the content", async () => {
    const productId = "prod_rekey_1";
    const productKey = genProductKey();
    mockSatsrailClient.getProductKey.mockResolvedValue({ key: productKey });
    const url = "https://cdn.example.com/secret-video.mp4";

    const { mediaId, dekBase64url } = await seedRepairScenario(url, productId, productKey);

    // Precondition: the stale row decrypts to the WRONG plaintext (not the DEK),
    // so a buyer could not open the freshly-minted envelope with it.
    const stale = await prisma.mediaProduct.findFirst({ where: { mediaId } });
    const staleDecoded = new TextDecoder().decode(
      await clientDecryptBlob(stale!.encryptedDek, productKey, productId)
    );
    expect(staleDecoded).toBe("stale-pre-migration-value");
    expect(staleDecoded).not.toBe(dekBase64url);

    // Repair.
    const result = await reencryptMediaProductsForMedia(mediaId, { sk: "sk_live_test" });
    expect(result.total).toBe(1);
    expect(result.reencrypted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(mockSatsrailClient.getProductKey).toHaveBeenCalledWith("sk_live_test", productId);

    // Buyer step 1: product key → MediaProduct.encryptedDek → the EXACT media DEK.
    const row = await prisma.mediaProduct.findFirst({ where: { mediaId } });
    const recoveredDek = new TextDecoder().decode(
      await clientDecryptBlob(row!.encryptedDek, productKey, productId)
    );
    expect(recoveredDek).toBe(dekBase64url);

    // Buyer step 2: media DEK → envelope bytes → the original URL payload.
    const envelope = await prisma.mediaEnvelope.findUnique({
      where: { mediaId },
      select: { bytes: true },
    });
    const urlBytes = await clientDecryptBytesWithKey(
      Uint8Array.from(envelope!.bytes),
      base64urlToBytes(recoveredDek)
    );
    expect(new TextDecoder().decode(urlBytes)).toBe(url);
  });

  it("reports an error and leaves the row untouched when SatsRail can't return the product key", async () => {
    const productId = "prod_rekey_err";
    const productKey = genProductKey();
    const url = "https://cdn.example.com/x.mp4";
    const { mediaId } = await seedRepairScenario(url, productId, productKey);
    const before = (await prisma.mediaProduct.findFirst({ where: { mediaId } }))!.encryptedDek;

    mockSatsrailClient.getProductKey.mockRejectedValue(new Error("portal down"));
    const result = await reencryptMediaProductsForMedia(mediaId, { sk: "sk_live_test" });

    expect(result.reencrypted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].satsrailProductId).toBe(productId);

    // Idempotent/safe: the row is unchanged, so a retry can fix it.
    const after = (await prisma.mediaProduct.findFirst({ where: { mediaId } }))!.encryptedDek;
    expect(after).toBe(before);
  });

  it("throws when the media has no envelope — nothing to recover the DEK from", async () => {
    const channel = await prisma.channel.create({
      data: { ref: nextRef(), slug: `rk-${nextRef()}`, name: "RK", active: true },
    });
    const media = await prisma.media.create({
      data: { ref: nextRef(), channelId: channel.id, name: "No env", mediaType: "video" },
    });
    await expect(
      reencryptMediaProductsForMedia(media.id, { sk: "sk_live_test" })
    ).rejects.toThrow(/no envelope/i);
  });
});
