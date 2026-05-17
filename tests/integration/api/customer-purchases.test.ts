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

// Mock customer auth — use vi.hoisted to create ObjectId before vi.mock factories
const { customerId } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Types } = require("mongoose");
  return { customerId: new Types.ObjectId() };
});
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
    id: customerId.toString(),
    name: "testuser",
  }),
}));

// Mock satsrail
import { mockSatsrailClient } from "../../helpers/mocks/satsrail";
vi.mock("@/lib/satsrail", () => ({
  satsrail: mockSatsrailClient,
}));

// Mock encryption (decryptSecretKey used in POST for order verification)
vi.mock("@/lib/encryption", () => ({
  decryptSecretKey: vi.fn().mockReturnValue("sk_decrypted_key"),
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/customer/purchases/route";
import { createCustomer, createSettings } from "../../helpers/factories";

function buildPostRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/customer/purchases"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Customer Purchases routes", () => {
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

  describe("GET /api/customer/purchases", () => {
    it("returns empty purchases initially", async () => {
      await createCustomer({ _id: customerId, nickname: "buyer" });

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.purchases).toEqual([]);
    });
  });

  describe("POST /api/customer/purchases", () => {
    it("records a purchase (from_checkout bypasses verification)", async () => {
      await createCustomer({ _id: customerId, nickname: "buyer" });

      const req = buildPostRequest({
        order_id: "from_checkout",
        product_id: "prod_abc",
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.ok).toBe(true);

      // Verify via GET
      const getRes = await GET();
      const getBody = await getRes.json();
      expect(getBody.purchases).toHaveLength(1);
      expect(getBody.purchases[0].satsrail_product_id).toBe("prod_abc");
    });

    it("prevents duplicate purchases", async () => {
      await createCustomer({
        _id: customerId,
        nickname: "buyer",
        purchases: [
          {
            satsrail_order_id: "order_1",
            satsrail_product_id: "prod_dup",
            purchased_at: new Date(),
          },
        ],
      });

      const req = buildPostRequest({
        order_id: "from_checkout",
        product_id: "prod_dup",
      });
      const res = await POST(req);

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("Already purchased");
    });

    it("returns 400 for invalid data", async () => {
      await createCustomer({ _id: customerId, nickname: "buyer" });

      const req = buildPostRequest({});
      const res = await POST(req);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Validation failed");
    });

    it("returns 404 when the customer no longer exists", async () => {
      // No customer with this id in DB

      const req = buildPostRequest({
        order_id: "from_checkout",
        product_id: "prod_missing_customer",
      });
      const res = await POST(req);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("Customer not found");
    });

    it("returns 403 when SatsRail order is not paid", async () => {
      await createCustomer({ _id: customerId, nickname: "buyer" });
      await createSettings({ satsrail_api_key_encrypted: "encrypted_key_value" });

      mockSatsrailClient.getOrder.mockResolvedValue({
        id: "order_unpaid",
        status: "pending",
        total_cents: 1000,
        currency: "USD",
      });

      const req = buildPostRequest({
        order_id: "order_unpaid",
        product_id: "prod_xyz",
      });
      const res = await POST(req);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Order not verified");
    });

    it("returns 403 when SatsRail returns a falsy order", async () => {
      await createCustomer({ _id: customerId, nickname: "buyer" });
      await createSettings({ satsrail_api_key_encrypted: "encrypted_key_value" });

      mockSatsrailClient.getOrder.mockResolvedValue(null);

      const req = buildPostRequest({
        order_id: "order_missing",
        product_id: "prod_xyz",
      });
      const res = await POST(req);
      expect(res.status).toBe(403);
    });

    it("returns 502 when SatsRail verification throws", async () => {
      await createCustomer({ _id: customerId, nickname: "buyer" });
      await createSettings({ satsrail_api_key_encrypted: "encrypted_key_value" });

      mockSatsrailClient.getOrder.mockRejectedValue(new Error("network down"));

      const req = buildPostRequest({
        order_id: "order_broken",
        product_id: "prod_xyz",
      });
      const res = await POST(req);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe("Failed to verify order");
    });

    it("skips order verification when no settings are configured", async () => {
      await createCustomer({ _id: customerId, nickname: "buyer" });
      // No Settings — should fall through and just record the purchase

      const req = buildPostRequest({
        order_id: "order_no_settings",
        product_id: "prod_settings_missing",
      });
      const res = await POST(req);
      expect(res.status).toBe(201);
      expect(mockSatsrailClient.getOrder).not.toHaveBeenCalled();
    });

    it("verifies order against SatsRail for non-checkout orders", async () => {
      await createCustomer({ _id: customerId, nickname: "buyer" });
      await createSettings({
        satsrail_api_key_encrypted: "encrypted_key_value",
      });

      mockSatsrailClient.getOrder.mockResolvedValue({
        id: "order_verified",
        status: "paid",
        total_cents: 1000,
        currency: "USD",
      });

      const req = buildPostRequest({
        order_id: "order_verified",
        product_id: "prod_xyz",
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.ok).toBe(true);
      expect(mockSatsrailClient.getOrder).toHaveBeenCalledWith(
        "sk_decrypted_key",
        "order_verified"
      );
    });
  });
});
