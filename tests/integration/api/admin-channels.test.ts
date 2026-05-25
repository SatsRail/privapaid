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

// Mock satsrail
import { mockSatsrailClient } from "../../helpers/mocks/satsrail";
vi.mock("@/lib/satsrail", () => ({
  satsrail: mockSatsrailClient,
}));

// Mock merchant-key
vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: vi.fn().mockResolvedValue("sk_test_key"),
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/admin/channels/route";
import { createChannel, createCategory } from "../../helpers/factories";

function buildGetRequest(query: string = ""): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000/api/admin/channels${query}`), {
    method: "GET",
  });
}

function buildPostRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/admin/channels"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Admin Channels list/create routes", () => {
  beforeAll(async () => {
    await setupTestDB();
    mockSatsrailClient.createProductType.mockResolvedValue({
      id: "pt_123",
      name: "Test",
      external_ref: "ch_1",
    });
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    mockSatsrailClient.createProductType.mockResolvedValue({
      id: "pt_123",
      name: "Test",
      external_ref: "ch_1",
    });
  });

  describe("GET /api/admin/channels", () => {
    it("lists channels with pagination", async () => {
      await createChannel({ name: "Channel A", slug: "channel-a" });
      await createChannel({ name: "Channel B", slug: "channel-b" });

      const req = buildGetRequest("?page=1&limit=10");
      const res = await GET(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(10);
      expect(body.total_pages).toBe(1);
    });

    it("filters by category_id", async () => {
      const category = await createCategory({ name: "Cat", slug: "cat" });
      await createChannel({
        name: "Filtered",
        slug: "filtered",
        categoryId: category.id,
      });
      await createChannel({ name: "Other", slug: "other" });

      const req = buildGetRequest(`?category_id=${category.id}`);
      const res = await GET(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe("Filtered");
    });
  });

  describe("POST /api/admin/channels", () => {
    it("creates channel with slug", async () => {
      const req = buildPostRequest({ name: "My Channel", slug: "my-channel" });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.data.name).toBe("My Channel");
      expect(body.data.slug).toBe("my-channel");
      expect(body.data.ref).toBeDefined();
    });

    it("auto-generates slug from name", async () => {
      const req = buildPostRequest({ name: "Auto Slug Channel" });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.data.slug).toBe("auto-slug-channel");
    });

    it("rejects duplicate slug", async () => {
      await createChannel({ name: "Existing", slug: "taken-slug" });

      const req = buildPostRequest({ name: "New", slug: "taken-slug" });
      const res = await POST(req);

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("Slug already taken");
    });

    it("returns 400 for invalid data (missing name)", async () => {
      const req = buildPostRequest({});
      const res = await POST(req);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Validation failed");
    });
  });
});
