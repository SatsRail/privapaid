import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createCategory } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

describe("Category model", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates a category with required fields", async () => {
    const category = await createCategory({ name: "Music", slug: "music" });
    expect(category.name).toBe("Music");
    expect(category.slug).toBe("music");
  });

  it("sets default values", async () => {
    const category = await createCategory();
    expect(category.position).toBe(0);
    expect(category.active).toBe(true);
  });

  it("enforces slug uniqueness", async () => {
    await createCategory({ slug: "unique-cat" });
    await expect(createCategory({ slug: "unique-cat" })).rejects.toThrow();
  });

  it("queries sorted by position", async () => {
    await createCategory({ name: "Second", slug: "second", position: 2 });
    await createCategory({ name: "First", slug: "first", position: 1 });
    await createCategory({ name: "Third", slug: "third", position: 3 });

    const categories = await prisma.category.findMany({ orderBy: { position: "asc" } });
    expect(categories.map((c) => c.name)).toEqual(["First", "Second", "Third"]);
  });

  it("queries active categories only", async () => {
    await createCategory({ slug: "active-cat", active: true });
    await createCategory({ slug: "inactive-cat", active: false });
    const active = await prisma.category.findMany({ where: { active: true } });
    expect(active).toHaveLength(1);
  });
});
