import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// Mock the auth function from @/lib/auth
const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

// Mock next/navigation redirect
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import {
  requireAdmin,
  requireOwner,
  requireCustomer,
  requireAdminApi,
  requireOwnerApi,
  requireCustomerApi,
  hasPurchaseForProduct,
} from "@/lib/auth-helpers";

describe("auth-helpers", () => {
  beforeEach(() => {
    mockAuth.mockReset();
  });

  describe("requireAdminApi", () => {
    it("returns admin session when authenticated as admin", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-1", email: "admin@test.com", name: "Admin", type: "admin", role: "owner" },
      });
      const result = await requireAdminApi();
      expect(result).not.toBeInstanceOf(NextResponse);
      expect(result).toMatchObject({ id: "admin-1", type: "admin", role: "owner" });
    });

    it("returns 401 when no session", async () => {
      mockAuth.mockResolvedValue(null);
      const result = await requireAdminApi();
      expect(result).toBeInstanceOf(NextResponse);
      expect((result as NextResponse).status).toBe(401);
    });

    it("returns 401 when customer session", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "cust-1", name: "user", type: "customer" },
      });
      const result = await requireAdminApi();
      expect(result).toBeInstanceOf(NextResponse);
      expect((result as NextResponse).status).toBe(401);
    });
  });

  describe("requireOwnerApi", () => {
    it("returns session when role is owner", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-1", email: "admin@test.com", name: "Admin", type: "admin", role: "owner" },
      });
      const result = await requireOwnerApi();
      expect(result).not.toBeInstanceOf(NextResponse);
      expect(result).toMatchObject({ role: "owner" });
    });

    it("returns 403 when admin but not owner", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-2", email: "mgr@test.com", name: "Manager", type: "admin", role: "admin" },
      });
      const result = await requireOwnerApi();
      expect(result).toBeInstanceOf(NextResponse);
      expect((result as NextResponse).status).toBe(403);
    });

    it("returns 401 when not authenticated", async () => {
      mockAuth.mockResolvedValue(null);
      const result = await requireOwnerApi();
      expect(result).toBeInstanceOf(NextResponse);
      expect((result as NextResponse).status).toBe(401);
    });
  });

  describe("requireCustomerApi", () => {
    it("returns customer session when authenticated", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "cust-1", name: "testuser", type: "customer" },
      });
      const result = await requireCustomerApi();
      expect(result).not.toBeInstanceOf(NextResponse);
      expect(result).toMatchObject({ id: "cust-1", type: "customer" });
    });

    it("returns 401 when not authenticated", async () => {
      mockAuth.mockResolvedValue(null);
      const result = await requireCustomerApi();
      expect(result).toBeInstanceOf(NextResponse);
      expect((result as NextResponse).status).toBe(401);
    });

    it("returns 401 when admin session", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-1", email: "admin@test.com", name: "Admin", type: "admin", role: "owner" },
      });
      const result = await requireCustomerApi();
      expect(result).toBeInstanceOf(NextResponse);
      expect((result as NextResponse).status).toBe(401);
    });
  });

  describe("requireAdmin (server component)", () => {
    it("returns admin session", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-1", email: "admin@test.com", name: "Admin", type: "admin", role: "owner" },
      });
      const result = await requireAdmin();
      expect(result).toMatchObject({ id: "admin-1", type: "admin" });
    });

    it("redirects when not authenticated", async () => {
      mockAuth.mockResolvedValue(null);
      await expect(requireAdmin()).rejects.toThrow("REDIRECT:/login");
    });
  });

  describe("requireOwner (server component)", () => {
    it("returns owner session", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-1", email: "admin@test.com", name: "Admin", type: "admin", role: "owner" },
      });
      const result = await requireOwner();
      expect(result).toMatchObject({ role: "owner" });
    });

    it("redirects non-owners to /admin/channels", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-2", email: "mgr@test.com", name: "Manager", type: "admin", role: "admin" },
      });
      await expect(requireOwner()).rejects.toThrow("REDIRECT:/admin/channels");
    });
  });

  describe("requireCustomer (server component)", () => {
    it("returns customer session", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "cust-1", name: "testuser", type: "customer" },
      });
      const result = await requireCustomer();
      expect(result).toMatchObject({ id: "cust-1", type: "customer" });
    });

    it("redirects when not authenticated", async () => {
      mockAuth.mockResolvedValue(null);
      await expect(requireCustomer()).rejects.toThrow("REDIRECT:/login");
    });
  });

  describe("hasPurchaseForProduct", () => {
    it("returns true when customer has purchased one of the products", () => {
      const purchases = [
        { satsrail_product_id: "prod_1" },
        { satsrail_product_id: "prod_2" },
      ];
      expect(hasPurchaseForProduct(purchases, ["prod_2", "prod_3"])).toBe(true);
    });

    it("returns false when customer has not purchased any of the products", () => {
      const purchases = [{ satsrail_product_id: "prod_1" }];
      expect(hasPurchaseForProduct(purchases, ["prod_2", "prod_3"])).toBe(false);
    });

    it("returns false for empty purchases", () => {
      expect(hasPurchaseForProduct([], ["prod_1"])).toBe(false);
    });

    it("returns false for empty product IDs", () => {
      const purchases = [{ satsrail_product_id: "prod_1" }];
      expect(hasPurchaseForProduct(purchases, [])).toBe(false);
    });
  });

  describe("fallback branches (null name/email/role)", () => {
    it("requireAdmin fills empty defaults when session user lacks email/name/role", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-bare", type: "admin" },
      });
      const result = await requireAdmin();
      expect(result.id).toBe("admin-bare");
      expect(result.email).toBe("");
      expect(result.name).toBe("");
      expect(result.role).toBe("admin"); // fallback default
    });

    it("requireAdminApi fills empty defaults when user lacks email/name/role", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-bare", type: "admin" },
      });
      const result = await requireAdminApi();
      expect(result).not.toBeInstanceOf(NextResponse);
      expect(result).toMatchObject({ id: "admin-bare", email: "", name: "", role: "admin" });
    });

    it("requireCustomer returns empty name when user.name is missing", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "cust-bare", type: "customer" },
      });
      const result = await requireCustomer();
      expect(result).toMatchObject({ id: "cust-bare", name: "", type: "customer" });
    });

    it("requireCustomerApi returns empty name when user.name is missing", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "cust-bare", type: "customer" },
      });
      const result = await requireCustomerApi();
      expect(result).not.toBeInstanceOf(NextResponse);
      expect(result).toMatchObject({ id: "cust-bare", name: "", type: "customer" });
    });
  });
});
