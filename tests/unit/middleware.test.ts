import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock next-auth/jwt
const mockGetToken = vi.fn();
vi.mock("next-auth/jwt", () => ({
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

import { middleware } from "@/middleware";

function createRequest(pathname: string): NextRequest {
  return new NextRequest(new URL(pathname, "http://localhost:3000"));
}

describe("middleware", () => {
  beforeEach(() => {
    mockGetToken.mockReset();
  });

  describe("setup routes", () => {
    it("bypasses auth for /setup", async () => {
      const res = await middleware(createRequest("/setup"));
      // NextResponse.next() has no redirect and status is implicitly 200
      expect(res.headers.get("x-middleware-next")).toBeTruthy();
    });

    it("bypasses auth for /api/setup paths", async () => {
      const res = await middleware(createRequest("/api/setup/status"));
      expect(res.headers.get("x-middleware-next")).toBeTruthy();
    });
  });

  describe("admin pages", () => {
    it("redirects to login when no token", async () => {
      mockGetToken.mockResolvedValue(null);
      const res = await middleware(createRequest("/admin/channels"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/login");
      expect(res.headers.get("location")).toContain("callbackUrl");
    });

    it("allows admin token through", async () => {
      mockGetToken.mockResolvedValue({ type: "admin", role: "owner" });
      const res = await middleware(createRequest("/admin/channels"));
      expect(res.headers.get("x-middleware-next")).toBeTruthy();
    });

    it("redirects non-owner admin from owner-only pages", async () => {
      mockGetToken.mockResolvedValue({ type: "admin", role: "manager" });
      const res = await middleware(createRequest("/admin/categories"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/admin/channels");
    });

    it("allows owner to access owner-only pages", async () => {
      mockGetToken.mockResolvedValue({ type: "admin", role: "owner" });
      const res = await middleware(createRequest("/admin/categories"));
      expect(res.headers.get("x-middleware-next")).toBeTruthy();
    });

    it("redirects non-owner from /admin dashboard", async () => {
      mockGetToken.mockResolvedValue({ type: "admin", role: "manager" });
      const res = await middleware(createRequest("/admin"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/admin/channels");
    });

    it("redirects non-owner from /admin/settings", async () => {
      mockGetToken.mockResolvedValue({ type: "admin", role: "manager" });
      const res = await middleware(createRequest("/admin/settings"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/admin/channels");
    });
  });

  describe("admin API routes", () => {
    it("returns 401 when no token", async () => {
      mockGetToken.mockResolvedValue(null);
      const res = await middleware(createRequest("/api/admin/channels"));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("allows admin through", async () => {
      mockGetToken.mockResolvedValue({ type: "admin", role: "admin" });
      const res = await middleware(createRequest("/api/admin/channels"));
      expect(res.headers.get("x-middleware-next")).toBeTruthy();
    });

    it("returns 403 for owner-only API routes when not owner", async () => {
      mockGetToken.mockResolvedValue({ type: "admin", role: "manager" });
      const res = await middleware(createRequest("/api/admin/categories"));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Forbidden");
    });

    it("allows owner for owner-only API routes", async () => {
      mockGetToken.mockResolvedValue({ type: "admin", role: "owner" });
      const res = await middleware(createRequest("/api/admin/settings"));
      expect(res.headers.get("x-middleware-next")).toBeTruthy();
    });
  });

});
