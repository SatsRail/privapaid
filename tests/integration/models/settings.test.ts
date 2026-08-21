import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createSettings } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

describe("Settings model", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates settings with required fields", async () => {
    const settings = await createSettings({ instanceName: "My Instance" });
    expect(settings.instanceName).toBe("My Instance");
    expect(settings.setupCompleted).toBe(true);
  });

  it("sets theme defaults", async () => {
    const settings = await createSettings();
    expect(settings.themePrimary).toBe("#3b82f6");
    expect(settings.themeBg).toBe("#0a0a0a");
    expect(settings.themeBgSecondary).toBe("#18181b");
    expect(settings.themeText).toBe("#ededed");
    expect(settings.themeTextSecondary).toBe("#a1a1aa");
    expect(settings.themeHeading).toBe("#fafafa");
    expect(settings.themeBorder).toBe("#27272a");
    expect(settings.themeFont).toBe("Geist");
  });

  it("sets SatsRail defaults", async () => {
    const settings = await createSettings();
    expect(settings.satsrailApiUrl).toBe("https://app.satsrail.com/api/v1");
    expect(settings.satsrailApiKeyEncrypted).toBeNull();
    expect(settings.merchantId).toBeNull();
    expect(settings.merchantCurrency).toBe("USD");
    expect(settings.merchantLocale).toBe("en");
  });

  it("sets other defaults", async () => {
    const settings = await createSettings();
    expect(settings.nsfwEnabled).toBe(false);
    expect(settings.instanceDomain).toBe("localhost:3000");
    expect(settings.logoUrl).toBe("");
    expect(settings.aboutText).toBe("");
    expect(settings.googleAnalyticsId).toBe("");
  });

  it("updates settings", async () => {
    await createSettings();
    const updated = await prisma.settings.update({
      where: { id: 1 },
      data: { instanceName: "Updated Name", themePrimary: "#ff5500" },
    });
    expect(updated.instanceName).toBe("Updated Name");
    expect(updated.themePrimary).toBe("#ff5500");
  });

  it("creates timestamps", async () => {
    const settings = await createSettings();
    expect(settings.createdAt).toBeInstanceOf(Date);
    expect(settings.updatedAt).toBeInstanceOf(Date);
  });
});
