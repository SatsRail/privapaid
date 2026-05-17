import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";

const { mockRequireCustomerApi } = vi.hoisted(() => ({
  mockRequireCustomerApi: vi.fn(),
}));

// Mocks — MUST be before route imports
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));
vi.mock("@/lib/mongodb", () => ({ connectDB: vi.fn().mockImplementation(async () => mongoose) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
  requireOwnerApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
  requireCustomerApi: mockRequireCustomerApi,
}));
vi.mock("@/lib/satsrail", () => ({ satsrail: {} }));
vi.mock("@/lib/merchant-key", () => ({ getMerchantKey: vi.fn().mockResolvedValue("sk_test_key") }));

import { NextResponse } from "next/server";
import { GET, PATCH } from "@/app/api/customer/profile/route";
import { createCustomer } from "../../helpers/factories";

function jsonRequest(url: string, method: string, body?: Record<string, unknown>): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

describe("Customer Profile API", () => {
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

  describe("GET /api/customer/profile", () => {
    it("returns current customer profile", async () => {
      const customer = await createCustomer({ nickname: "testuser" });
      mockRequireCustomerApi.mockResolvedValue({ id: customer._id.toString(), name: "testuser" });

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.nickname).toBe("testuser");
      expect(body.data.password_hash).toBeUndefined();
    });

    it("returns 404 when customer not found", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      mockRequireCustomerApi.mockResolvedValue({ id: fakeId, name: "ghost" });

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe("Not found");
    });
  });

  describe("PATCH /api/customer/profile", () => {
    it("updates profile_image_id", async () => {
      const customer = await createCustomer({ nickname: "patcher" });
      mockRequireCustomerApi.mockResolvedValue({ id: customer._id.toString(), name: "patcher" });

      const req = jsonRequest("http://localhost:3000/api/customer/profile", "PATCH", {
        profile_image_id: "img_abc123",
      });
      const res = await PATCH(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.profile_image_id).toBe("img_abc123");
      expect(body.data.password_hash).toBeUndefined();
    });

    it("returns 404 when customer not found during update", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      mockRequireCustomerApi.mockResolvedValue({ id: fakeId, name: "ghost" });

      const req = jsonRequest("http://localhost:3000/api/customer/profile", "PATCH", {
        profile_image_id: "img_xyz",
      });
      const res = await PATCH(req);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe("Not found");
    });

    it("handles empty update body", async () => {
      const customer = await createCustomer({ nickname: "empty_update" });
      mockRequireCustomerApi.mockResolvedValue({ id: customer._id.toString(), name: "empty_update" });

      const req = jsonRequest("http://localhost:3000/api/customer/profile", "PATCH", {});
      const res = await PATCH(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.nickname).toBe("empty_update");
    });

    it("PATCH returns 401 when requireCustomerApi denies access", async () => {
      mockRequireCustomerApi.mockResolvedValue(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      );
      const req = jsonRequest("http://localhost:3000/api/customer/profile", "PATCH", {
        profile_image_id: "img",
      });
      const res = await PATCH(req);
      expect(res.status).toBe(401);
    });

    it("PATCH returns 400 when validation fails", async () => {
      const customer = await createCustomer({ nickname: "valfail" });
      mockRequireCustomerApi.mockResolvedValue({ id: customer._id.toString(), name: "valfail" });

      const req = jsonRequest("http://localhost:3000/api/customer/profile", "PATCH", {
        profile_image_id: 123, // not a string
      });
      const res = await PATCH(req);
      expect(res.status).toBe(400);
    });
  });

  describe("auth gating", () => {
    it("GET returns 401 when requireCustomerApi denies access", async () => {
      mockRequireCustomerApi.mockResolvedValue(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      );
      const res = await GET();
      expect(res.status).toBe(401);
    });
  });
});
