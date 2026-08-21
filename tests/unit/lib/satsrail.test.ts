const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("global", () => ({}));

// Mock the config module
vi.mock("@/config/instance", () => ({
  default: {
    satsrail: {
      apiUrl: "https://app.satsrail.com/api/v1",
    },
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";

// Replace global fetch with our mock
globalThis.fetch = mockFetch;

// Import after mocks are set up
const { satsrail } = await import("@/lib/satsrail");

describe("SatsRailClient", () => {
  const secretKey = "sk_live_test123";

  beforeEach(() => {
    mockFetch.mockReset();
  });

  // --- private request() method tested via public methods ---

  describe("request() internals (via createProduct)", () => {
    it("sends correct headers and body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: "prod_1", name: "Test" }),
      });

      await satsrail.createProduct(secretKey, {
        name: "Test",
        price_cents: 1000,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/m/products",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secretKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ product: { name: "Test", price_cents: 1000 } }),
        }
      );
    });

    it("defaults method to GET when not specified (via getProduct)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: "prod_1" }),
      });

      await satsrail.getProduct(secretKey, "prod_1");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/m/products/prod_1",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("throws on non-ok response with JSON error body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        json: () => Promise.resolve({ error: "Invalid params" }),
      });

      await expect(
        satsrail.createProduct(secretKey, { name: "X", price_cents: 0 })
      ).rejects.toThrow('SatsRail API error 422: {"error":"Invalid params"}');
    });

    it("throws on non-ok response when JSON parse fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.reject(new Error("not json")),
      });

      await expect(
        satsrail.createProduct(secretKey, { name: "X", price_cents: 0 })
      ).rejects.toThrow(
        'SatsRail API error 500: {"error":"Internal Server Error"}'
      );
    });

    it("returns undefined for 204 status", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: () => Promise.reject(new Error("no body")),
      });

      const result = await satsrail.deleteProduct(secretKey, "prod_1");
      expect(result).toBeUndefined();
    });

    it("does not send body when body is undefined (GET requests)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: "prod_1" }),
      });

      await satsrail.getProduct(secretKey, "prod_1");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: undefined })
      );
    });
  });

  // --- Products ---

  describe("createProduct", () => {
    it("creates a product with all optional fields", async () => {
      const product = {
        id: "prod_1",
        name: "Video",
        price_cents: 500,
        currency: "USD",
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(product),
      });

      const result = await satsrail.createProduct(secretKey, {
        name: "Video",
        price_cents: 500,
        currency: "USD",
        access_duration_seconds: 3600,
        image_url: "https://img.com/1.png",
        product_type_id: "pt_1",
        external_ref: "ext_1",
      });

      expect(result).toEqual(product);
    });
  });

  describe("listProducts", () => {
    it("lists products without filters", async () => {
      const response = { object: "list", data: [], meta: {} };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(response),
      });

      const result = await satsrail.listProducts(secretKey);
      expect(result).toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/m/products",
        expect.any(Object)
      );
    });

    it("lists products with filters", async () => {
      const response = { object: "list", data: [], meta: {} };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(response),
      });

      await satsrail.listProducts(secretKey, {
        status_eq: "active",
        name_cont: "video",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("q%5Bstatus_eq%5D=active"),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("q%5Bname_cont%5D=video"),
        expect.any(Object)
      );
    });
  });

  describe("getProductKey", () => {
    it("fetches the product key", async () => {
      const keyData = { key: "abc123", key_fingerprint: "fp_123" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(keyData),
      });

      const result = await satsrail.getProductKey(secretKey, "prod_1");
      expect(result).toEqual(keyData);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/m/products/prod_1/key",
        expect.any(Object)
      );
    });
  });

  describe("rotateProductKey", () => {
    it("rotates the product key", async () => {
      const keyData = { key: "new_key", previous_key: "old_key" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(keyData),
      });

      const result = await satsrail.rotateProductKey(secretKey, "prod_1");
      expect(result).toEqual(keyData);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/m/products/prod_1/rotate_key",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("clearOldKey", () => {
    it("clears the old key", async () => {
      const product = { id: "prod_1" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(product),
      });

      const result = await satsrail.clearOldKey(secretKey, "prod_1");
      expect(result).toEqual(product);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/m/products/prod_1/clear_old_key",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("updateProduct", () => {
    it("updates a product", async () => {
      const product = { id: "prod_1", name: "Updated" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(product),
      });

      const result = await satsrail.updateProduct(secretKey, "prod_1", {
        name: "Updated",
      });
      expect(result).toEqual(product);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/m/products/prod_1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ product: { name: "Updated" } }),
        })
      );
    });
  });

  describe("Lifetime normalization", () => {
    function jsonOk(value: unknown) {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(value),
      };
    }

    it("createProduct strips access_duration_seconds when it is 0 (lifetime)", async () => {
      mockFetch.mockResolvedValueOnce(jsonOk({ id: "prod_lifetime" }));

      await satsrail.createProduct(secretKey, {
        name: "Lifetime Article",
        price_cents: 100,
        currency: "USD",
        access_duration_seconds: 0,
        product_type_id: "pt_1",
      });

      const body = JSON.parse(
        (mockFetch.mock.calls[0][1] as { body: string }).body
      );
      expect(body.product).not.toHaveProperty("access_duration_seconds");
      expect(body.product.name).toBe("Lifetime Article");
      expect(body.product.product_type_id).toBe("pt_1");
    });

    it("createProduct strips access_duration_seconds when null", async () => {
      mockFetch.mockResolvedValueOnce(jsonOk({ id: "prod_2" }));

      await satsrail.createProduct(secretKey, {
        name: "X",
        price_cents: 100,
        access_duration_seconds: null as unknown as number,
      });

      const body = JSON.parse(
        (mockFetch.mock.calls[0][1] as { body: string }).body
      );
      expect(body.product).not.toHaveProperty("access_duration_seconds");
    });

    it("createProduct preserves positive access_duration_seconds", async () => {
      mockFetch.mockResolvedValueOnce(jsonOk({ id: "prod_3" }));

      await satsrail.createProduct(secretKey, {
        name: "Time-Gated",
        price_cents: 100,
        access_duration_seconds: 3600,
      });

      const body = JSON.parse(
        (mockFetch.mock.calls[0][1] as { body: string }).body
      );
      expect(body.product.access_duration_seconds).toBe(3600);
    });

    it("updateProduct strips access_duration_seconds when it is 0", async () => {
      mockFetch.mockResolvedValueOnce(jsonOk({ id: "prod_1" }));

      await satsrail.updateProduct(secretKey, "prod_1", {
        name: "Now lifetime",
        access_duration_seconds: 0,
      });

      const body = JSON.parse(
        (mockFetch.mock.calls[0][1] as { body: string }).body
      );
      expect(body.product).not.toHaveProperty("access_duration_seconds");
      expect(body.product.name).toBe("Now lifetime");
    });

    it("updateProduct preserves positive access_duration_seconds", async () => {
      mockFetch.mockResolvedValueOnce(jsonOk({ id: "prod_1" }));

      await satsrail.updateProduct(secretKey, "prod_1", {
        access_duration_seconds: 86400,
      });

      const body = JSON.parse(
        (mockFetch.mock.calls[0][1] as { body: string }).body
      );
      expect(body.product.access_duration_seconds).toBe(86400);
    });
  });

  describe("deleteProduct", () => {
    it("deletes a product", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await satsrail.deleteProduct(secretKey, "prod_1");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/m/products/prod_1",
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });

  // --- Product Types ---

  describe("listProductTypes", () => {
    it("lists product types", async () => {
      const response = { object: "list", data: [], meta: {} };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(response),
      });

      const result = await satsrail.listProductTypes(secretKey);
      expect(result).toEqual(response);
    });
  });

  describe("createProductType", () => {
    it("creates a product type", async () => {
      const pt = { id: "pt_1", name: "Channel", object: "product_type" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(pt),
      });

      const result = await satsrail.createProductType(secretKey, {
        name: "Channel",
        external_ref: "ch_ext",
      });
      expect(result).toEqual(pt);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/m/product_types",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            product_type: { name: "Channel", external_ref: "ch_ext" },
          }),
        })
      );
    });
  });

  // --- Orders ---

  describe("createOrder", () => {
    it("creates an order", async () => {
      const order = { id: "ord_1", status: "pending" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(order),
      });

      const result = await satsrail.createOrder(secretKey, {
        items: [{ product_id: "prod_1" }],
      });
      expect(result).toEqual(order);
    });
  });

  describe("getOrder", () => {
    it("gets an order", async () => {
      const order = { id: "ord_1", status: "completed" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(order),
      });

      const result = await satsrail.getOrder(secretKey, "ord_1");
      expect(result).toEqual(order);
    });
  });

  // --- Checkout Sessions ---

  describe("createCheckoutSession", () => {
    it("creates a checkout session", async () => {
      const session = { token: "tok_1", checkout_url: "https://example.com" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(session),
      });

      const result = await satsrail.createCheckoutSession(secretKey, {
        order_id: "ord_1",
      });
      expect(result).toEqual(session);
    });
  });

  // --- Token Usage ---

  describe("getTokenUsage", () => {
    it("gets token usage", async () => {
      const usage = { rpm_limit: 60, monthly_request_count: 100, current_rpm: 5 };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(usage),
      });

      const result = await satsrail.getTokenUsage(secretKey, "tok_1");
      expect(result).toEqual(usage);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/m/api_tokens/tok_1/usage",
        expect.any(Object)
      );
    });
  });

  // --- Access Verification ---

  describe("verifyAccess", () => {
    it("verifies access with a macaroon", async () => {
      const response = { key: "key_123", remaining_seconds: 3600 };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(response),
      });

      const result = await satsrail.verifyAccess("sk_live_test", "mac_token_123");
      expect(result).toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/m/access/verify",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Authorization": "Bearer sk_live_test",
          }),
          body: JSON.stringify({ access_token: "mac_token_123" }),
        })
      );
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "invalid" }),
      });

      await expect(satsrail.verifyAccess("sk_live_test", "bad_mac")).rejects.toThrow();
    });
  });

  // --- Payments ---

  describe("listPayments", () => {
    it("lists payments without params", async () => {
      const payments = [{ id: "pay_1" }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(payments),
      });

      const result = await satsrail.listPayments(secretKey);
      expect(result).toEqual(payments);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/m/payments",
        expect.any(Object)
      );
    });

    it("lists payments with page param", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

      await satsrail.listPayments(secretKey, { page: 2 });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("page=2"),
        expect.any(Object)
      );
    });

    it("lists payments with per_page param", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

      await satsrail.listPayments(secretKey, { per_page: 50 });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("per_page=50"),
        expect.any(Object)
      );
    });

    it("lists payments with both page and per_page", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

      await satsrail.listPayments(secretKey, { page: 3, per_page: 25 });
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("page=3");
      expect(url).toContain("per_page=25");
    });
  });

  // --- Merchant ---

  describe("getMerchant", () => {
    it("gets merchant info", async () => {
      const merchant = { id: "m_1", name: "Test Shop" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(merchant),
      });

      const result = await satsrail.getMerchant(secretKey);
      expect(result).toEqual(merchant);
    });
  });

  // --- Sessions ---

  describe("createSession", () => {
    it("creates a session with default base URL", async () => {
      const session = {
        session_token: "st_123",
        merchants: [{ id: "m_1", name: "Shop" }],
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(session),
      });

      const result = await satsrail.createSession("user@test.com", "pass123");
      expect(result).toEqual(session);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/m/sessions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "user@test.com",
            password: "pass123",
          }),
        }
      );
    });

    it("creates a session with custom API URL", async () => {
      const session = { session_token: "st_1", merchants: [] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(session),
      });

      await satsrail.createSession(
        "user@test.com",
        "pass123",
        "https://custom.api/api/v1"
      );

      expect(mockFetch).toHaveBeenCalledWith(
        "https://custom.api/api/v1/m/sessions",
        expect.any(Object)
      );
    });

    it("throws on non-ok response with JSON error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: () => Promise.resolve({ error: "Invalid credentials" }),
      });

      await expect(
        satsrail.createSession("user@test.com", "wrong")
      ).rejects.toThrow(
        'SatsRail API error 401: {"error":"Invalid credentials"}'
      );
    });

    it("throws on non-ok response when JSON parse fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.reject(new Error("not json")),
      });

      await expect(
        satsrail.createSession("user@test.com", "pass")
      ).rejects.toThrow(
        'SatsRail API error 500: {"error":"Internal Server Error"}'
      );
    });
  });

  // --- Checkout QR ---

  describe("getCheckoutQr", () => {
    it("fetches checkout QR (strips /api/v1 for portal URL)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve("<svg>qr</svg>"),
      });

      const result = await satsrail.getCheckoutQr("tok_abc");
      expect(result).toBe("<svg>qr</svg>");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/checkout/tok_abc/qr"
      );
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(satsrail.getCheckoutQr("bad_tok")).rejects.toThrow(
        "Failed to fetch checkout QR: 404"
      );
    });
  });

  // --- Checkout Status ---

  describe("getCheckoutStatus", () => {
    it("fetches checkout status", async () => {
      const status = { status: "pending", time_remaining: 300 };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(status),
      });

      const result = await satsrail.getCheckoutStatus("tok_abc");
      expect(result).toEqual(status);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/checkout/tok_abc/status"
      );
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(satsrail.getCheckoutStatus("bad_tok")).rejects.toThrow(
        "Failed to fetch checkout status: 404"
      );
    });
  });

  // --- Exchanges ---

  describe("getExchanges", () => {
    it("fetches exchanges", async () => {
      const exchanges = [{ id: "ex_1", name: "Kraken" }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ exchanges }),
      });

      const result = await satsrail.getExchanges();
      expect(result).toEqual(exchanges);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.satsrail.com/api/v1/pub/exchanges"
      );
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(satsrail.getExchanges()).rejects.toThrow(
        "Failed to fetch exchanges: 500"
      );
    });
  });
});
