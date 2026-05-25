import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createSettings } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

import { encryptSecretKey } from "@/lib/encryption";
import { getMerchantKey } from "@/lib/merchant-key";

describe("getMerchantKey", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("returns null when no settings exist", async () => {
    const key = await getMerchantKey();
    expect(key).toBeNull();
  });

  it("returns null when no encrypted key is stored", async () => {
    await createSettings({ satsrailApiKeyEncrypted: null });
    const key = await getMerchantKey();
    expect(key).toBeNull();
  });

  it("returns null when encrypted key is empty string", async () => {
    await createSettings();
    await prisma.settings.update({ where: { id: 1 }, data: { satsrailApiKeyEncrypted: "" } });
    const key = await getMerchantKey();
    expect(key).toBeNull();
  });

  it("decrypts and returns the merchant key", async () => {
    const originalKey = "sk_live_abc123def456";
    const encrypted = encryptSecretKey(originalKey);
    await createSettings({ satsrailApiKeyEncrypted: encrypted });

    const key = await getMerchantKey();
    expect(key).toBe(originalKey);
  });

  it("round-trips different key formats correctly", async () => {
    const keys = [
      "sk_live_short",
      "sk_live_" + "x".repeat(200),
      "sk_live_special-chars_123!@#",
    ];

    for (const originalKey of keys) {
      const encrypted = encryptSecretKey(originalKey);
      await prisma.settings.upsert({
        where: { id: 1 },
        create: { id: 1, instanceName: "x", satsrailApiKeyEncrypted: encrypted },
        update: { satsrailApiKeyEncrypted: encrypted },
      });
      const result = await getMerchantKey();
      expect(result).toBe(originalKey);
    }
  });
});
