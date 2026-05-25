/* eslint-disable @typescript-eslint/no-explicit-any */

const mockAuditLogCreate = vi.hoisted(() => vi.fn());
const mockHeadersGet = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: mockAuditLogCreate,
    },
  },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue({
    get: mockHeadersGet,
  }),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { audit } from "@/lib/audit";

describe("audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeadersGet.mockReturnValue(null);
  });

  it("creates an audit log entry with all fields", async () => {
    mockAuditLogCreate.mockResolvedValue({});
    mockHeadersGet.mockImplementation((name: string) => {
      if (name === "x-forwarded-for") return "1.2.3.4, 5.6.7.8";
      if (name === "user-agent") return "TestBrowser/1.0";
      return null;
    });

    await audit({
      actorId: "admin_123",
      actorEmail: "admin@test.com",
      actorType: "admin",
      action: "login",
      targetType: "session",
      targetId: "sess_456",
      details: { method: "password" },
    });

    expect(mockAuditLogCreate).toHaveBeenCalledWith({
      data: {
        actorId: "admin_123",
        actorEmail: "admin@test.com",
        actorType: "admin",
        action: "login",
        targetType: "session",
        targetId: "sess_456",
        details: { method: "password" },
        ip: "1.2.3.4",
        userAgent: "TestBrowser/1.0",
      },
    });
  });

  it("uses x-real-ip when x-forwarded-for is absent", async () => {
    mockAuditLogCreate.mockResolvedValue({});
    mockHeadersGet.mockImplementation((name: string) => {
      if (name === "x-real-ip") return "10.0.0.1";
      return null;
    });

    await audit({
      actorId: "sys",
      actorType: "system",
      action: "cron.run",
    });

    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ip: "10.0.0.1" }) })
    );
  });

  it("defaults optional fields to empty strings / empty object", async () => {
    mockAuditLogCreate.mockResolvedValue({});

    await audit({
      actorId: "admin_1",
      actorType: "admin",
      action: "view",
    });

    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorEmail: "",
          targetType: "",
          targetId: "",
          details: {},
        }),
      })
    );
  });

  it("defaults ip and userAgent to empty strings when headers are missing", async () => {
    mockAuditLogCreate.mockResolvedValue({});

    await audit({
      actorId: "sys",
      actorType: "system",
      action: "startup",
    });

    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ip: "",
          userAgent: "",
        }),
      })
    );
  });

  it("does not throw when prisma.auditLog.create fails (fire-and-forget)", async () => {
    mockAuditLogCreate.mockRejectedValue(new Error("DB down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      audit({
        actorId: "sys",
        actorType: "system",
        action: "fail",
      })
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      "Audit log write failed:",
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });

  it("does not throw when headers() rejects", async () => {
    const { headers } = await import("next/headers");
    (headers as any).mockRejectedValueOnce(new Error("No request context"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      audit({
        actorId: "sys",
        actorType: "system",
        action: "fail",
      })
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
