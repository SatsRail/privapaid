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

  it("auto-assigns ref via the Postgres sequence when omitted", async () => {
    // The migration sets Channel.ref's default to nextval(channel_ref_seq),
    // so callers can omit ref entirely. The factory relies on this. If the
    // sequence is missing or unbound, this test fails with a NOT NULL
    // violation — which is exactly the alarm bell we want.
    const a = await prisma.channel.create({
      data: { name: "Seq A", slug: "seq-a" },
    });
    const b = await prisma.channel.create({
      data: { name: "Seq B", slug: "seq-b" },
    });
    expect(typeof a.ref).toBe("number");
    expect(typeof b.ref).toBe("number");
    // Strict monotonicity is the contract — parallel vitest workers can
    // bump the shared sequence between these two inserts, so we don't
    // assert `a.ref + 1` exactly.
    expect(b.ref).toBeGreaterThan(a.ref);
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
