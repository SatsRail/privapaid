import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────

const prismaMock = vi.hoisted(() => ({
  mediaProduct: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  channelProduct: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  channelProductMedia: {
    deleteMany: vi.fn(),
    create: vi.fn(),
  },
  channel: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  media: {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  $transaction: vi.fn().mockImplementation(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/models/Counter", () => ({
  getNextRef: vi.fn().mockResolvedValue(500),
}));

const mockCreateProductType = vi.fn();
const mockListProductTypes = vi.fn();
const mockCreateProduct = vi.fn();
const mockListProducts = vi.fn();
const mockGetProductKey = vi.fn();
const mockUpdateProduct = vi.fn();
vi.mock("@/lib/satsrail", () => ({
  satsrail: {
    createProductType: (...args: unknown[]) => mockCreateProductType(...args),
    listProductTypes: (...args: unknown[]) => mockListProductTypes(...args),
    createProduct: (...args: unknown[]) => mockCreateProduct(...args),
    listProducts: (...args: unknown[]) => mockListProducts(...args),
    getProductKey: (...args: unknown[]) => mockGetProductKey(...args),
    updateProduct: (...args: unknown[]) => mockUpdateProduct(...args),
  },
}));

const mockEncryptSourceUrl = vi.fn().mockReturnValue("encrypted_url");
vi.mock("@/lib/content-encryption", () => ({
  encryptSourceUrl: (...args: unknown[]) => mockEncryptSourceUrl(...args),
}));

vi.mock("@/lib/validate", () => ({
  schemas: {},
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import {
  withRetry,
  isExternalRefTaken,
  createProductSafeType,
  createProductSafe,
  getProductKeySafe,
  createApiThrottle,
} from "@/lib/import-helpers";

// ─── Tests ──────────────────────────────────────────────────────────

describe("import-helpers", () => {
  const api = createApiThrottle(0);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── withRetry ─────────────────────────────────────────────────────

  describe("withRetry", () => {
    it("returns the result on first success", async () => {
      const fn = vi.fn().mockResolvedValue("ok");
      const result = await withRetry(fn);
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("throws immediately for non-rate-limit errors", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("Connection refused"));
      await expect(withRetry(fn)).rejects.toThrow("Connection refused");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("throws immediately for non-Error throws", async () => {
      const fn = vi.fn().mockRejectedValue("string error");
      await expect(withRetry(fn)).rejects.toBe("string error");
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // ── isExternalRefTaken ────────────────────────────────────────────

  describe("isExternalRefTaken", () => {
    it("returns true for external ref taken error", () => {
      expect(isExternalRefTaken(new Error("External ref has already been taken"))).toBe(true);
    });

    it("returns false for other errors", () => {
      expect(isExternalRefTaken(new Error("Something else"))).toBe(false);
    });

    it("returns false for non-Error values", () => {
      expect(isExternalRefTaken("string")).toBe(false);
      expect(isExternalRefTaken(null)).toBe(false);
    });
  });

  // ── createProductSafeType ─────────────────────────────────────────

  describe("createProductSafeType", () => {
    it("creates product type when none exists", async () => {
      mockListProductTypes.mockResolvedValue({ data: [] });
      mockCreateProductType.mockResolvedValue({ id: "pt_1" });
      const result = await createProductSafeType("sk", "Name", "ref_1", api);
      expect(result).toEqual({ id: "pt_1" });
      expect(mockListProductTypes).toHaveBeenCalledOnce();
      expect(mockCreateProductType).toHaveBeenCalledOnce();
    });

    it("returns existing product type when found by external_ref", async () => {
      mockListProductTypes.mockResolvedValue({
        data: [
          { id: "pt_old", external_ref: "ref_1" },
          { id: "pt_other", external_ref: "ref_other" },
        ],
      });

      const result = await createProductSafeType("sk", "Name", "ref_1", api);
      expect(result).toEqual({ id: "pt_old", external_ref: "ref_1" });
      expect(mockCreateProductType).not.toHaveBeenCalled();
    });

    it("creates product type when no match found in existing list", async () => {
      mockListProductTypes.mockResolvedValue({
        data: [{ id: "pt_other", external_ref: "ref_other" }],
      });
      mockCreateProductType.mockResolvedValue({ id: "pt_new" });

      const result = await createProductSafeType("sk", "Name", "ref_1", api);
      expect(result).toEqual({ id: "pt_new" });
    });

    it("throws creation errors", async () => {
      mockListProductTypes.mockResolvedValue({ data: [] });
      mockCreateProductType.mockRejectedValue(new Error("Server error"));
      await expect(createProductSafeType("sk", "Name", "ref_1", api)).rejects.toThrow("Server error");
    });
  });

  // ── createProductSafe ─────────────────────────────────────────────

  describe("createProductSafe", () => {
    const productData = {
      name: "Product",
      price_cents: 100,
      external_ref: "md_1",
    };

    it("creates product when none exists by external_ref", async () => {
      mockListProducts.mockResolvedValue({ data: [] });
      mockCreateProduct.mockResolvedValue({ id: "prod_1" });
      const result = await createProductSafe("sk", productData, api);
      expect(result).toEqual({ id: "prod_1" });
      expect(mockListProducts).toHaveBeenCalledOnce();
      expect(mockCreateProduct).toHaveBeenCalledOnce();
    });

    it("returns existing product and updates metadata when found by external_ref", async () => {
      mockListProducts.mockResolvedValue({
        data: [{ id: "prod_existing", external_ref: "md_1" }],
      });
      mockUpdateProduct.mockResolvedValue({});

      const result = await createProductSafe("sk", productData, api);
      expect(result).toEqual({ id: "prod_existing", external_ref: "md_1" });
      expect(mockCreateProduct).not.toHaveBeenCalled();
      expect(mockUpdateProduct).toHaveBeenCalledWith("sk", "prod_existing", {
        name: "Product",
        price_cents: 100,
        access_duration_seconds: undefined,
      });
    });

    it("creates product when no external_ref provided (skips check)", async () => {
      mockCreateProduct.mockResolvedValue({ id: "prod_new" });
      const result = await createProductSafe("sk", { name: "Product", price_cents: 100 }, api);
      expect(result).toEqual({ id: "prod_new" });
      expect(mockListProducts).not.toHaveBeenCalled();
    });

    it("throws creation errors", async () => {
      mockListProducts.mockResolvedValue({ data: [] });
      mockCreateProduct.mockRejectedValue(new Error("Validation failed"));
      await expect(createProductSafe("sk", productData, api)).rejects.toThrow("Validation failed");
    });
  });

  // ── getProductKeySafe ─────────────────────────────────────────────

  describe("getProductKeySafe", () => {
    const productData = {
      name: "Product",
      price_cents: 100,
      external_ref: "md_1",
    };

    it("returns key on success", async () => {
      mockGetProductKey.mockResolvedValue({ key: "k1", key_fingerprint: "fp1" });
      const result = await getProductKeySafe("sk", "prod_1", productData, api);
      expect(result).toEqual({ productId: "prod_1", key: "k1", key_fingerprint: "fp1" });
    });

    it("creates fresh product on 404 error", async () => {
      mockGetProductKey
        .mockRejectedValueOnce(new Error("404 Not Found"))
        .mockResolvedValue({ key: "k2", key_fingerprint: "fp2" });
      mockCreateProduct.mockResolvedValue({ id: "prod_new" });

      const result = await getProductKeySafe("sk", "prod_orphan", productData, api);
      expect(result).toEqual({ productId: "prod_new", key: "k2", key_fingerprint: "fp2" });
      expect(mockCreateProduct).toHaveBeenCalled();
    });

    it("throws non-404 errors directly", async () => {
      mockGetProductKey.mockRejectedValue(new Error("500 Internal Server Error"));
      await expect(getProductKeySafe("sk", "prod_1", productData, api)).rejects.toThrow("500");
    });
  });
});
