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
vi.mock("@/config/instance", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/config/instance")>(),
  default: { nsfw: false },
  clearConfigCache: vi.fn(),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET, PUT } from "@/app/api/admin/settings/route";
import { requireOwnerApi } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { createSettings } from "../../helpers/factories";
import { getInstanceConfig } from "@/config/instance";
import { COLOR_FIELDS, resolveTheme } from "@/config/theme";

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
    it("persists all theme colors and exposes them through GET and public config", async () => {
      await createSettings();
      const colors = Object.fromEntries(COLOR_FIELDS.map(({ key }, i) => [key, `#${(0x102030 + i * 0x010101).toString(16)}`]));
      const response = await PUT(buildPutRequest(colors));
      expect(response.status).toBe(200);
      expect((await response.json()).settings).toMatchObject(colors);
      expect((await (await GET()).json()).settings).toMatchObject(colors);
      const config = await getInstanceConfig();
      for (const { key, token } of COLOR_FIELDS) expect(config.theme[token]).toBe(colors[key]);
    });

    it("clears optional overrides without overwriting the base palette", async () => {
      await createSettings();
      await prisma.settings.updateMany({ data: { themeBg: "#ffffff", themeNavBg: "#123456", themePrimaryText: "#eeeeee" } });
      const response = await PUT(buildPutRequest({ theme_nav_bg: "", theme_primary_text: null }));
      expect(response.status).toBe(200);
      const settings = (await response.json()).settings;
      expect(settings.theme_nav_bg).toBeNull();
      expect(settings.theme_primary_text).toBeNull();
      expect(settings.theme_bg).toBe("#ffffff");
      expect(resolveTheme((await getInstanceConfig()).theme).navBg).toBe("#ffffff");
    });

    it.each(COLOR_FIELDS.filter(({ group }) => group !== "base"))("rejects invalid $key without writing other fields", async ({ key }) => {
      await createSettings({ instanceName: "Original" });
      const response = await PUT(buildPutRequest({ [key]: "url(https://example.com)", instance_name: "Changed" }));
      expect(response.status).toBe(400);
      expect((await prisma.settings.findFirstOrThrow()).instanceName).toBe("Original");
    });

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
