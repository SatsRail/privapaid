import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel, createCategory, createCustomer, createSettings } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

// Mock rate limit
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

// Mock next/cache
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Mock config cache
vi.mock("@/config/instance", () => ({
  clearConfigCache: vi.fn(),
}));

const mockRequireOwnerApi = vi.fn();

// Mock admin auth
vi.mock("@/lib/auth-helpers", () => ({
  requireOwnerApi: (...args: unknown[]) => mockRequireOwnerApi(...args),
}));

import { POST } from "@/app/api/admin/settings/reset/route";

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

afterEach(async () => {
  await clearCollections();
  mockRequireOwnerApi.mockReset();
  mockRequireOwnerApi.mockResolvedValue({
    id: "admin-1",
    email: "admin@test.com",
    role: "owner",
  });
});

function resetRequest(body?: Record<string, unknown>) {
  return new Request("http://localhost/api/admin/settings/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

describe("POST /api/admin/settings/reset", () => {
  beforeAll(() => {
    mockRequireOwnerApi.mockResolvedValue({
      id: "admin-1",
      email: "admin@test.com",
      role: "owner",
    });
  });

  it("requires owner authentication", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireOwnerApi.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );

    const res = await POST(resetRequest({ confirm: "RESET" }));
    expect(res.status).toBe(401);
  });

  it("rejects missing confirm field", async () => {
    const res = await POST(resetRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("RESET");
  });

  it("rejects wrong confirm phrase", async () => {
    const res = await POST(resetRequest({ confirm: "DELETE" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("RESET");
  });

  it("rejects invalid JSON body", async () => {
    const req = new Request("http://localhost/api/admin/settings/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request body");
  });

  it("truncates all tables on valid confirm", async () => {
    // Seed some data
    await createChannel({ name: "Test Channel", slug: "test-ch" });
    await createCategory({ name: "Test Category", slug: "test-cat" });
    await createCustomer({ nickname: "testuser" });
    await createSettings({
      instanceName: "Test Instance",
      merchantId: "m_123",
      satsrailApiKeyEncrypted: "enc_key",
    });

    // Verify data exists
    expect(await prisma.channel.count()).toBeGreaterThan(0);
    expect(await prisma.category.count()).toBeGreaterThan(0);
    expect(await prisma.customer.count()).toBeGreaterThan(0);
    expect(await prisma.settings.count()).toBeGreaterThan(0);

    const res = await POST(resetRequest({ confirm: "RESET" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.reset).toBe(true);
    expect(body.collections_dropped).toBeDefined();
    expect(Array.isArray(body.collections_dropped)).toBe(true);
    expect(body.collections_dropped.length).toBeGreaterThan(0);

    // Verify all data is gone
    expect(await prisma.channel.count()).toBe(0);
    expect(await prisma.category.count()).toBe(0);
    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.settings.count()).toBe(0);
  });

  it("returns list of dropped collections (tables)", async () => {
    await createChannel({ name: "Ch", slug: "ch" });

    const res = await POST(resetRequest({ confirm: "RESET" }));
    const body = await res.json();

    expect(body.collections_dropped).toEqual(
      expect.arrayContaining([expect.any(String)])
    );
  });

  it("returns 500 when the underlying truncate throws (outer catch)", async () => {
    const queryRawSpy = vi
      .spyOn(prisma, "$queryRaw" as never)
      .mockImplementationOnce((() => {
        throw new Error("queryRaw boom");
      }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const res = await POST(resetRequest({ confirm: "RESET" }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Failed to reset application");
      expect(errSpy).toHaveBeenCalled();
    } finally {
      queryRawSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
