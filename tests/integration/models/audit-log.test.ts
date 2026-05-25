import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { prisma } from "@/lib/prisma";

describe("AuditLog model", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates an audit log with required fields", async () => {
    const log = await prisma.auditLog.create({
      data: {
        actorId: "admin_123",
        actorType: "admin",
        action: "media.create",
      },
    });
    expect(log.id).toBeDefined();
    expect(log.actorId).toBe("admin_123");
    expect(log.actorType).toBe("admin");
    expect(log.action).toBe("media.create");
  });

  it("sets default values", async () => {
    const log = await prisma.auditLog.create({
      data: {
        actorId: "system",
        actorType: "system",
        action: "cleanup.run",
      },
    });
    expect(log.actorEmail).toBe("");
    expect(log.targetType).toBe("");
    expect(log.targetId).toBe("");
    expect(log.details).toEqual({});
    expect(log.ip).toBe("");
    expect(log.userAgent).toBe("");
    expect(log.createdAt).toBeInstanceOf(Date);
  });

  it("accepts all valid actor types", async () => {
    const admin = await prisma.auditLog.create({
      data: { actorId: "a1", actorType: "admin", action: "test" },
    });
    const system = await prisma.auditLog.create({
      data: { actorId: "s1", actorType: "system", action: "test" },
    });
    expect(admin.actorType).toBe("admin");
    expect(system.actorType).toBe("system");
  });

  it("stores details as JSON", async () => {
    const log = await prisma.auditLog.create({
      data: {
        actorId: "admin_1",
        actorType: "admin",
        action: "settings.update",
        details: { field: "instance_name", old_value: "Old", new_value: "New" },
      },
    });
    expect(log.details).toEqual({
      field: "instance_name",
      old_value: "Old",
      new_value: "New",
    });
  });

  it("stores IP and user agent", async () => {
    const log = await prisma.auditLog.create({
      data: {
        actorId: "admin_1",
        actorType: "admin",
        action: "login",
        ip: "192.168.1.1",
        userAgent: "Mozilla/5.0",
      },
    });
    expect(log.ip).toBe("192.168.1.1");
    expect(log.userAgent).toBe("Mozilla/5.0");
  });

  it("queries by actor and action", async () => {
    await prisma.auditLog.create({
      data: { actorId: "admin_1", actorType: "admin", action: "media.create" },
    });
    await prisma.auditLog.create({
      data: { actorId: "admin_1", actorType: "admin", action: "media.delete" },
    });
    await prisma.auditLog.create({
      data: { actorId: "admin_2", actorType: "admin", action: "media.create" },
    });

    const byActor = await prisma.auditLog.findMany({ where: { actorId: "admin_1" } });
    expect(byActor).toHaveLength(2);

    const byAction = await prisma.auditLog.findMany({ where: { action: "media.create" } });
    expect(byAction).toHaveLength(2);
  });

  it("queries by target", async () => {
    await prisma.auditLog.create({
      data: {
        actorId: "admin_1",
        actorType: "admin",
        action: "media.update",
        targetType: "Media",
        targetId: "media_abc",
      },
    });
    const results = await prisma.auditLog.findMany({
      where: { targetType: "Media", targetId: "media_abc" },
    });
    expect(results).toHaveLength(1);
  });
});
