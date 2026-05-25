import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel, createCategory } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

describe("Channel model", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates a channel with required fields", async () => {
    const channel = await createChannel({ name: "Test Channel", slug: "test-ch" });
    expect(channel.name).toBe("Test Channel");
    expect(channel.slug).toBe("test-ch");
    expect(channel.id).toBeDefined();
  });

  it("sets default values", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: 9999,
        slug: "defaults-test",
        name: "Defaults Test",
      },
    });
    expect(channel.active).toBe(true);
    expect(channel.nsfw).toBe(false);
    expect(channel.isLive).toBe(false);
    expect(channel.mediaCount).toBe(0);
    expect(channel.bio).toBe("");
    expect(channel.deletedAt).toBeNull();
  });

  it("creates timestamps", async () => {
    const channel = await createChannel();
    expect(channel.createdAt).toBeInstanceOf(Date);
    expect(channel.updatedAt).toBeInstanceOf(Date);
  });

  it("enforces slug uniqueness", async () => {
    await createChannel({ slug: "unique-slug" });
    await expect(createChannel({ slug: "unique-slug" })).rejects.toThrow();
  });

  it("stores social links as JSON", async () => {
    const channel = await createChannel();
    const updated = await prisma.channel.update({
      where: { id: channel.id },
      data: { socialLinks: { youtube: "https://youtube.com/@test", twitter: "@test" } },
    });
    const links = updated.socialLinks as { youtube: string; twitter: string };
    expect(links.youtube).toBe("https://youtube.com/@test");
    expect(links.twitter).toBe("@test");
  });

  it("can associate with a category", async () => {
    const category = await createCategory();
    const channel = await createChannel({ categoryId: category.id });
    expect(channel.categoryId).toBe(category.id);
  });

  it("queries active channels", async () => {
    await createChannel({ active: true, slug: "active-ch" });
    await createChannel({ active: false, slug: "inactive-ch" });
    const active = await prisma.channel.findMany({ where: { active: true } });
    expect(active).toHaveLength(1);
    expect(active[0].slug).toBe("active-ch");
  });
});
