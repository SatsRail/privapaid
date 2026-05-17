import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";

// Mock rate limit
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

// Mock connectDB
vi.mock("@/lib/mongodb", () => ({
  connectDB: vi.fn().mockImplementation(async () => mongoose),
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

import { NextRequest, NextResponse } from "next/server";
import { GET, PATCH, DELETE } from "@/app/api/admin/categories/[id]/route";
import { requireAdminApi } from "@/lib/auth-helpers";
import { createCategory } from "../../helpers/factories";

function buildRequest(
  method: string,
  id: string,
  body?: unknown
): [NextRequest, { params: Promise<{ id: string }> }] {
  const url = `http://localhost:3000/api/admin/categories/${id}`;
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) init.body = JSON.stringify(body);
  return [new NextRequest(new URL(url), init), { params: Promise.resolve({ id }) }];
}

describe("Admin Categories [id] routes", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  describe("GET /api/admin/categories/:id", () => {
    it("returns category by ID", async () => {
      const category = await createCategory({ name: "Music", slug: "music" });
      const [req, ctx] = buildRequest("GET", category._id.toString());
      const res = await GET(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.name).toBe("Music");
      expect(body.data.slug).toBe("music");
    });

    it("returns 404 for missing ID", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const [req, ctx] = buildRequest("GET", fakeId);
      const res = await GET(req, ctx);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Not found");
    });
  });

  describe("PATCH /api/admin/categories/:id", () => {
    it("updates category name", async () => {
      const category = await createCategory({ name: "Old Name", slug: "old-name" });
      const [req, ctx] = buildRequest("PATCH", category._id.toString(), { name: "New Name" });
      const res = await PATCH(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.name).toBe("New Name");
    });

    it("rejects duplicate slug", async () => {
      await createCategory({ name: "Existing", slug: "existing-slug" });
      const target = await createCategory({ name: "Target", slug: "target-slug" });
      const [req, ctx] = buildRequest("PATCH", target._id.toString(), {
        slug: "existing-slug",
      });
      const res = await PATCH(req, ctx);

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("Slug already taken");
    });

    it("returns 404 for missing category", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const [req, ctx] = buildRequest("PATCH", fakeId, { name: "Nope" });
      const res = await PATCH(req, ctx);

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/admin/categories/:id", () => {
    it("soft-deletes category (sets active: false)", async () => {
      const category = await createCategory({ name: "ToDelete", slug: "to-delete", active: true });
      const [req, ctx] = buildRequest("DELETE", category._id.toString());
      const res = await DELETE(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.active).toBe(false);
    });

    it("returns 404 for missing category", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const [req, ctx] = buildRequest("DELETE", fakeId);
      const res = await DELETE(req, ctx);

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH branch coverage", () => {
    it("updates slug, position, and active in one call", async () => {
      const category = await createCategory({ name: "Multi", slug: "multi", position: 1, active: true });
      const [req, ctx] = buildRequest("PATCH", category._id.toString(), {
        slug: "multi-updated",
        position: 9,
        active: false,
      });
      const res = await PATCH(req, ctx);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.slug).toBe("multi-updated");
      expect(body.data.position).toBe(9);
      expect(body.data.active).toBe(false);
    });

    it("returns 400 when payload fails validation", async () => {
      const category = await createCategory({ name: "Vfail", slug: "vfail" });
      const [req, ctx] = buildRequest("PATCH", category._id.toString(), {
        slug: "INVALID UPPER",
      });
      const res = await PATCH(req, ctx);
      expect(res.status).toBe(400);
    });
  });

  describe("auth gating", () => {
    afterEach(() => {
      vi.mocked(requireAdminApi).mockResolvedValue({
        id: "admin-1",
        email: "admin@test.com",
        role: "owner",
      });
    });

    it("GET returns NextResponse from requireAdminApi when unauthorized", async () => {
      vi.mocked(requireAdminApi).mockResolvedValueOnce(
        NextResponse.json({ error: "Forbidden" }, { status: 403 })
      );
      const fakeId = new mongoose.Types.ObjectId().toString();
      const [req, ctx] = buildRequest("GET", fakeId);
      const res = await GET(req, ctx);
      expect(res.status).toBe(403);
    });

    it("PATCH returns NextResponse from requireAdminApi when unauthorized", async () => {
      vi.mocked(requireAdminApi).mockResolvedValueOnce(
        NextResponse.json({ error: "Forbidden" }, { status: 403 })
      );
      const fakeId = new mongoose.Types.ObjectId().toString();
      const [req, ctx] = buildRequest("PATCH", fakeId, { name: "X" });
      const res = await PATCH(req, ctx);
      expect(res.status).toBe(403);
    });

    it("DELETE returns NextResponse from requireAdminApi when unauthorized", async () => {
      vi.mocked(requireAdminApi).mockResolvedValueOnce(
        NextResponse.json({ error: "Forbidden" }, { status: 403 })
      );
      const fakeId = new mongoose.Types.ObjectId().toString();
      const [req, ctx] = buildRequest("DELETE", fakeId);
      const res = await DELETE(req, ctx);
      expect(res.status).toBe(403);
    });
  });
});
