import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";

// Mock rate limit
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

// Mock audit
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

// Mock admin auth
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: vi.fn().mockResolvedValue({
    id: "admin-1",
    email: "admin@test.com",
    role: "owner",
  }),
  requireOwnerApi: vi.fn().mockResolvedValue({
    id: "admin-1",
    email: "admin@test.com",
    role: "owner",
  }),
  requireCustomerApi: vi.fn().mockResolvedValue({
    id: "customer-1",
    name: "testuser",
  }),
}));

// Mock next/cache
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Mock config cache
vi.mock("@/config/instance", () => ({
  default: { nsfw: false },
  clearConfigCache: vi.fn(),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET, PUT } from "@/app/api/admin/settings/route";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { createSettings } from "../../helpers/factories";

function buildPutRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/admin/settings"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Admin Settings routes", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  describe("GET /api/admin/settings", () => {
    it("returns settings", async () => {
      await createSettings({ instanceName: "My Instance" });

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.settings.instance_name).toBe("My Instance");
      expect(body.settings.nsfw_enabled).toBe(false);
    });

    it("returns 404 when no settings exist", async () => {
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe("Settings not found");
    });
  });

  describe("PUT /api/admin/settings", () => {
    it("updates settings", async () => {
      await createSettings({ instanceName: "Old Name" });

      const req = buildPutRequest({ instance_name: "New Name" });
      const res = await PUT(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.settings.instance_name).toBe("New Name");
    });

    it("returns 404 when no settings exist", async () => {
      const req = buildPutRequest({ instance_name: "No Settings" });
      const res = await PUT(req);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe("Settings not found");
    });

    it("returns 400 when payload has no recognized fields", async () => {
      await createSettings({ instanceName: "x" });
      const req = buildPutRequest({});
      const res = await PUT(req);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/No valid fields/);
    });

    it("returns 400 when payload fails schema validation", async () => {
      await createSettings({ instanceName: "x" });
      const req = buildPutRequest({ theme_primary: "not-a-color" });
      const res = await PUT(req);
      expect(res.status).toBe(400);
    });

    it("returns 500 when the Prisma settings write throws", async () => {
      await createSettings({ instanceName: "x" });
      const spy = vi
        .spyOn(prisma.settings, "updateMany")
        .mockImplementationOnce(() => {
          throw new Error("db offline");
        });

      const req = buildPutRequest({ instance_name: "Anything" });
      const res = await PUT(req);
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("Failed to update settings");
      spy.mockRestore();
    });
  });

  describe("auth gating", () => {
    it("GET returns NextResponse from requireOwnerApi when unauthorized", async () => {
      vi.mocked(requireOwnerApi).mockResolvedValueOnce(
        NextResponse.json({ error: "Forbidden" }, { status: 403 })
      );
      const res = await GET();
      expect(res.status).toBe(403);
    });

    it("PUT returns NextResponse from requireOwnerApi when unauthorized", async () => {
      vi.mocked(requireOwnerApi).mockResolvedValueOnce(
        NextResponse.json({ error: "Forbidden" }, { status: 403 })
      );
      const req = buildPutRequest({ instance_name: "x" });
      const res = await PUT(req);
      expect(res.status).toBe(403);
    });
  });
});
