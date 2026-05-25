import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";

// Mocks — MUST be before route imports
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
  requireOwnerApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
  requireCustomerApi: vi.fn().mockResolvedValue({ id: "customer-1", name: "testuser" }),
}));
vi.mock("@/lib/satsrail", () => ({ satsrail: {} }));
vi.mock("@/lib/merchant-key", () => ({ getMerchantKey: vi.fn().mockResolvedValue("sk_test_key") }));

import { GET, POST } from "@/app/api/admin/categories/route";
import { createCategory } from "../../helpers/factories";

function jsonRequest(url: string, method: string, body?: Record<string, unknown>): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

describe("Admin Categories list/create routes", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
  });

  describe("GET /api/admin/categories", () => {
    it("lists categories sorted by position", async () => {
      await createCategory({ name: "Music", slug: "music", position: 2 });
      await createCategory({ name: "Art", slug: "art", position: 1 });

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].name).toBe("Art");
      expect(body.data[1].name).toBe("Music");
    });

    it("returns empty array when no categories exist", async () => {
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(0);
    });
  });

  describe("POST /api/admin/categories", () => {
    it("creates a category with auto-generated slug", async () => {
      const req = jsonRequest("http://localhost:3000/api/admin/categories", "POST", {
        name: "New Category",
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.data.name).toBe("New Category");
      expect(body.data.slug).toBe("new-category");
      expect(body.data.active).toBe(true);
    });

    it("creates a category with explicit slug", async () => {
      const req = jsonRequest("http://localhost:3000/api/admin/categories", "POST", {
        name: "My Cat",
        slug: "custom-slug",
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.data.slug).toBe("custom-slug");
    });

    it("creates a category with explicit position", async () => {
      const req = jsonRequest("http://localhost:3000/api/admin/categories", "POST", {
        name: "Positioned",
        position: 5,
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.data.position).toBe(5);
    });

    it("auto-increments position based on max existing", async () => {
      await createCategory({ name: "Existing", slug: "existing", position: 3 });

      const req = jsonRequest("http://localhost:3000/api/admin/categories", "POST", {
        name: "Next One",
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.data.position).toBe(4);
    });

    it("rejects duplicate slug", async () => {
      await createCategory({ name: "Taken", slug: "taken" });

      const req = jsonRequest("http://localhost:3000/api/admin/categories", "POST", {
        name: "Different",
        slug: "taken",
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(422);
      expect(body.error).toBe("A category with this slug already exists");
    });

    it("returns 400 for invalid data (missing name)", async () => {
      const req = jsonRequest("http://localhost:3000/api/admin/categories", "POST", {});
      const res = await POST(req);

      expect(res.status).toBe(400);
    });

    it("creates a category with active set to false", async () => {
      const req = jsonRequest("http://localhost:3000/api/admin/categories", "POST", {
        name: "Inactive",
        active: false,
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.data.active).toBe(false);
    });
  });
});
