import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createCategory } from "../../helpers/factories";

// Mock rate limit
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

// Mock admin auth
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: vi.fn().mockResolvedValue({
    id: "admin-1",
    email: "admin@test.com",
    role: "owner",
  }),
}));

import { NextRequest, NextResponse } from "next/server";
import { PATCH } from "@/app/api/admin/categories/reorder/route";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";

function buildRequest(body: unknown): NextRequest {
  return new NextRequest(
    new URL("http://localhost:3000/api/admin/categories/reorder"),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

describe("PATCH /api/admin/categories/reorder", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("reorders categories by updating positions", async () => {
    const cat1 = await createCategory({ name: "Cat A", position: 0 });
    const cat2 = await createCategory({ name: "Cat B", position: 1 });
    const cat3 = await createCategory({ name: "Cat C", position: 2 });

    const req = buildRequest({
      items: [
        { id: cat1.id, position: 2 },
        { id: cat2.id, position: 0 },
        { id: cat3.id, position: 1 },
      ],
    });

    const res = await PATCH(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const updated1 = await prisma.category.findUnique({ where: { id: cat1.id } });
    const updated2 = await prisma.category.findUnique({ where: { id: cat2.id } });
    const updated3 = await prisma.category.findUnique({ where: { id: cat3.id } });

    expect(updated1?.position).toBe(2);
    expect(updated2?.position).toBe(0);
    expect(updated3?.position).toBe(1);
  });

  it("returns 400 for invalid body (missing items)", async () => {
    const req = buildRequest({});
    const res = await PATCH(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 for items with empty id", async () => {
    const req = buildRequest({
      items: [{ id: "", position: 0 }],
    });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 for items with negative position", async () => {
    const cat = await createCategory();
    const req = buildRequest({
      items: [{ id: cat.id, position: -1 }],
    });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 for empty items array", async () => {
    const req = buildRequest({ items: [] });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
  });

  it("returns the auth response when requireAdminApi rejects the request", async () => {
    vi.mocked(requireAdminApi).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const req = buildRequest({ items: [{ id: "ckxyz12345678", position: 0 }] });
    const res = await PATCH(req);
    expect(res.status).toBe(401);
  });
});
