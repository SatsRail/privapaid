import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";

const { mockGetMerchantKey, mockSatsrailClient } = vi.hoisted(() => ({
  mockGetMerchantKey: vi.fn().mockResolvedValue("sk_test_key"),
  mockSatsrailClient: {
    listProductTypes: vi.fn(),
    createProductType: vi.fn(),
  },
}));

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
vi.mock("@/lib/satsrail", () => ({ satsrail: mockSatsrailClient }));
vi.mock("@/lib/merchant-key", () => ({ getMerchantKey: mockGetMerchantKey }));

import { GET, POST } from "@/app/api/admin/product-types/route";

function jsonRequest(url: string, method: string, body?: Record<string, unknown>): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

describe("Admin Product Types API", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    mockGetMerchantKey.mockResolvedValue("sk_test_key");
  });

  describe("GET /api/admin/product-types", () => {
    it("lists product types", async () => {
      mockSatsrailClient.listProductTypes.mockResolvedValue({
        data: [
          { id: "pt_1", name: "Video" },
          { id: "pt_2", name: "Audio" },
        ],
      });

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].name).toBe("Video");
    });

    it("returns 422 when merchant key not configured", async () => {
      mockGetMerchantKey.mockResolvedValue(null);

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(422);
      expect(body.error).toBe("Merchant API key not configured");
    });

    it("returns 502 when satsrail API throws Error", async () => {
      mockSatsrailClient.listProductTypes.mockRejectedValue(new Error("Connection refused"));

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(502);
      expect(body.error).toBe("Connection refused");
    });

    it("returns 502 with generic message for non-Error throws", async () => {
      mockSatsrailClient.listProductTypes.mockRejectedValue(42);

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(502);
      expect(body.error).toBe("Failed to list product types");
    });
  });

  describe("POST /api/admin/product-types", () => {
    it("creates a product type", async () => {
      mockSatsrailClient.createProductType.mockResolvedValue({
        id: "pt_new",
        name: "Podcast",
      });

      const req = jsonRequest("http://localhost:3000/api/admin/product-types", "POST", {
        name: "Podcast",
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.data.id).toBe("pt_new");
      expect(body.data.name).toBe("Podcast");
    });

    it("returns 400 for invalid data (missing name)", async () => {
      const req = jsonRequest("http://localhost:3000/api/admin/product-types", "POST", {});
      const res = await POST(req);

      expect(res.status).toBe(400);
    });

    it("returns 422 when merchant key not configured", async () => {
      mockGetMerchantKey.mockResolvedValue(null);

      const req = jsonRequest("http://localhost:3000/api/admin/product-types", "POST", {
        name: "Test",
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(422);
      expect(body.error).toBe("Merchant API key not configured");
    });

    it("returns 502 when satsrail API throws Error", async () => {
      mockSatsrailClient.createProductType.mockRejectedValue(new Error("API error"));

      const req = jsonRequest("http://localhost:3000/api/admin/product-types", "POST", {
        name: "Fail",
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(502);
      expect(body.error).toBe("API error");
    });

    it("returns 502 with generic message for non-Error throws", async () => {
      mockSatsrailClient.createProductType.mockRejectedValue(undefined);

      const req = jsonRequest("http://localhost:3000/api/admin/product-types", "POST", {
        name: "Fail",
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(502);
      expect(body.error).toBe("Failed to create product type");
    });
  });
});
