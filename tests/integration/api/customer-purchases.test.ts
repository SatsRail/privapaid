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

const { customerIdRef } = vi.hoisted(() => ({
  customerIdRef: { id: "" as string },
}));
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
  requireCustomerApi: vi.fn().mockImplementation(async () => ({
    id: customerIdRef.id,
    name: "testuser",
  })),
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
import { prisma } from "@/lib/prisma";
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
      const customer = await createCustomer({ nickname: "buyer" });
      customerIdRef.id = customer.id;

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.purchases).toEqual([]);
    });
  });

  describe("POST /api/customer/purchases", () => {
    it("records a purchase (from_checkout bypasses verification)", async () => {
      const customer = await createCustomer({ nickname: "buyer" });
      customerIdRef.id = customer.id;

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
      const customer = await createCustomer({ nickname: "buyer" });
      await prisma.purchase.create({
        data: {
          customerId: customer.id,
          satsrailOrderId: "order_1",
          satsrailProductId: "prod_dup",
        },
      });
      customerIdRef.id = customer.id;

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
      const customer = await createCustomer({ nickname: "buyer" });
      customerIdRef.id = customer.id;

      const req = buildPostRequest({});
      const res = await POST(req);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Validation failed");
    });

    it("returns 404 when the customer no longer exists", async () => {
      customerIdRef.id = "ckmissingfakefakefakefake";

      const req = buildPostRequest({
        order_id: "from_checkout",
        product_id: "prod_missing_customer",
      });
      const res = await POST(req);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("Customer not found");
    });

    it("returns 403 when SatsRail order is not paid", async () => {
      const customer = await createCustomer({ nickname: "buyer" });
      customerIdRef.id = customer.id;
      await createSettings({ satsrailApiKeyEncrypted: "encrypted_key_value" });

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
      const customer = await createCustomer({ nickname: "buyer" });
      customerIdRef.id = customer.id;
      await createSettings({ satsrailApiKeyEncrypted: "encrypted_key_value" });

      mockSatsrailClient.getOrder.mockResolvedValue(null);

      const req = buildPostRequest({
        order_id: "order_missing",
        product_id: "prod_xyz",
      });
      const res = await POST(req);
      expect(res.status).toBe(403);
    });

    it("returns 502 when SatsRail verification throws", async () => {
      const customer = await createCustomer({ nickname: "buyer" });
      customerIdRef.id = customer.id;
      await createSettings({ satsrailApiKeyEncrypted: "encrypted_key_value" });

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
      const customer = await createCustomer({ nickname: "buyer" });
      customerIdRef.id = customer.id;
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
      const customer = await createCustomer({ nickname: "buyer" });
      customerIdRef.id = customer.id;
      await createSettings({
        satsrailApiKeyEncrypted: "encrypted_key_value",
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

    it("returns 401 when requireCustomerApi returns a response (POST unauthenticated)", async () => {
      const { NextResponse } = await import("next/server");
      const authHelpers = await import("@/lib/auth-helpers");
      vi.mocked(authHelpers.requireCustomerApi).mockResolvedValueOnce(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      );

      const req = buildPostRequest({
        order_id: "from_checkout",
        product_id: "prod_unauth",
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
    });

    it("returns 401 when requireCustomerApi returns a response (GET unauthenticated)", async () => {
      const { NextResponse } = await import("next/server");
      const authHelpers = await import("@/lib/auth-helpers");
      vi.mocked(authHelpers.requireCustomerApi).mockResolvedValueOnce(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      );

      const res = await GET();
      expect(res.status).toBe(401);
    });

    it("returns 409 when Prisma raises P2002 during race-condition concurrent insert", async () => {
      const customer = await createCustomer({ nickname: "racer" });
      customerIdRef.id = customer.id;

      const { Prisma } = await import("@prisma/client");
      // Simulate concurrent insert race: existence check missed it, but
      // INSERT trips the unique constraint.
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed",
        { code: "P2002", clientVersion: "test" }
      );
      const spy = vi
        .spyOn(prisma.purchase, "create")
        .mockRejectedValueOnce(p2002);

      const req = buildPostRequest({
        order_id: "from_checkout",
        product_id: "prod_race",
      });
      const res = await POST(req);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("Already purchased");
      spy.mockRestore();
    });

    it("propagates non-P2002 Prisma errors during purchase insert", async () => {
      const customer = await createCustomer({ nickname: "errorbuyer" });
      customerIdRef.id = customer.id;

      // Generic error (not Prisma P2002) — should propagate
      const spy = vi
        .spyOn(prisma.purchase, "create")
        .mockRejectedValueOnce(new Error("db connection lost"));

      const req = buildPostRequest({
        order_id: "from_checkout",
        product_id: "prod_dberr",
      });
      await expect(POST(req)).rejects.toThrow("db connection lost");
      spy.mockRestore();
    });
  });
});
