import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { prisma } from "@/lib/prisma";

describe("Admin model", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates an admin with required fields", async () => {
    const admin = await prisma.admin.create({
      data: {
        email: "admin@test.com",
        passwordHash: "hashed_pw",
        name: "Test Admin",
      },
    });
    expect(admin.id).toBeDefined();
    expect(admin.email).toBe("admin@test.com");
    expect(admin.name).toBe("Test Admin");
    expect(admin.passwordHash).toBe("hashed_pw");
  });

  it("sets default values", async () => {
    const admin = await prisma.admin.create({
      data: {
        email: "defaults@test.com",
        passwordHash: "hashed_pw",
        name: "Defaults Test",
      },
    });
    expect(admin.role).toBe("admin");
    expect(admin.active).toBe(true);
  });

  it("creates timestamps", async () => {
    const admin = await prisma.admin.create({
      data: {
        email: "timestamps@test.com",
        passwordHash: "hashed_pw",
        name: "Timestamp Test",
      },
    });
    expect(admin.createdAt).toBeInstanceOf(Date);
    expect(admin.updatedAt).toBeInstanceOf(Date);
  });

  it("treats email as case-insensitive via Citext", async () => {
    await prisma.admin.create({
      data: {
        email: "UPPER@TEST.COM",
        passwordHash: "hashed_pw",
        name: "Upper Test",
      },
    });
    // Citext lookup should match regardless of case
    const found = await prisma.admin.findUnique({ where: { email: "upper@test.com" } });
    expect(found).toBeTruthy();
  });

  it("enforces email uniqueness", async () => {
    await prisma.admin.create({
      data: {
        email: "unique@test.com",
        passwordHash: "hashed_pw",
        name: "First",
      },
    });
    await expect(
      prisma.admin.create({
        data: {
          email: "unique@test.com",
          passwordHash: "hashed_pw",
          name: "Second",
        },
      })
    ).rejects.toThrow();
  });

  it("accepts valid roles", async () => {
    const owner = await prisma.admin.create({
      data: {
        email: "owner@test.com",
        passwordHash: "hashed_pw",
        name: "Owner",
        role: "owner",
      },
    });
    const moderator = await prisma.admin.create({
      data: {
        email: "mod@test.com",
        passwordHash: "hashed_pw",
        name: "Moderator",
        role: "moderator",
      },
    });
    expect(owner.role).toBe("owner");
    expect(moderator.role).toBe("moderator");
  });

  it("queries active admins", async () => {
    await prisma.admin.create({
      data: {
        email: "active@test.com",
        passwordHash: "hashed_pw",
        name: "Active",
        active: true,
      },
    });
    await prisma.admin.create({
      data: {
        email: "inactive@test.com",
        passwordHash: "hashed_pw",
        name: "Inactive",
        active: false,
      },
    });
    const active = await prisma.admin.findMany({ where: { active: true } });
    expect(active).toHaveLength(1);
    expect(active[0].email).toBe("active@test.com");
  });
});
