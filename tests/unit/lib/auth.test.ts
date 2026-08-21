/* eslint-disable @typescript-eslint/no-explicit-any */

// --- Hoisted mocks (must come before all imports) ---

const mockSettingsFindFirst = vi.hoisted(() => vi.fn());
const mockCreateSession = vi.hoisted(() => vi.fn());

// Capture the NextAuth config so we can test callbacks and authorize fns
const capturedConfig = vi.hoisted(() => ({ value: null as any }));

vi.mock("next-auth", () => ({
  default: (config: any) => {
    capturedConfig.value = config;
    return {
      handlers: {},
      signIn: vi.fn(),
      signOut: vi.fn(),
      auth: vi.fn(),
    };
  },
}));

vi.mock("next-auth/providers/credentials", () => ({
  default: (opts: any) => opts,
}));

vi.mock("@/lib/satsrail", () => ({
  satsrail: {
    createSession: mockCreateSession,
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    settings: {
      findFirst: mockSettingsFindFirst,
    },
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";

// Force the module to load, which triggers NextAuth(...) and captures config
await import("@/lib/auth");

// Extract provider authorize functions and callbacks
const adminProvider = capturedConfig.value.providers[0];
const { jwt: jwtCallback, session: sessionCallback } =
  capturedConfig.value.callbacks;

describe("auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- NextAuth configuration ---

  describe("NextAuth configuration", () => {
    it("has one credential provider", () => {
      expect(capturedConfig.value.providers).toHaveLength(1);
      expect(adminProvider.id).toBe("admin");
    });

    it("uses jwt strategy", () => {
      expect(capturedConfig.value.session.strategy).toBe("jwt");
    });

    it("has custom sign-in page", () => {
      expect(capturedConfig.value.pages.signIn).toBe("/login");
    });
  });

  // --- Admin authorize ---

  describe("admin authorize", () => {
    it("returns null when email is missing", async () => {
      const result = await adminProvider.authorize({ password: "pass" });
      expect(result).toBeNull();
    });

    it("returns null when password is missing", async () => {
      const result = await adminProvider.authorize({ email: "a@b.com" });
      expect(result).toBeNull();
    });

    it("returns null when credentials are empty", async () => {
      const result = await adminProvider.authorize({});
      expect(result).toBeNull();
    });

    it("returns null when credentials are null", async () => {
      const result = await adminProvider.authorize(null);
      expect(result).toBeNull();
    });

    it("returns null when settings not found", async () => {
      mockSettingsFindFirst.mockResolvedValue(null);

      const result = await adminProvider.authorize({
        email: "user@test.com",
        password: "pass123",
      });
      expect(result).toBeNull();
    });

    it("returns null when settings has no merchantId", async () => {
      mockSettingsFindFirst.mockResolvedValue({
        merchantId: null,
        satsrailApiUrl: "https://api.test.com",
      });

      const result = await adminProvider.authorize({
        email: "user@test.com",
        password: "pass123",
      });
      expect(result).toBeNull();
    });

    it("returns null when settings has no satsrailApiUrl", async () => {
      mockSettingsFindFirst.mockResolvedValue({
        merchantId: "m_1",
        satsrailApiUrl: null,
      });

      const result = await adminProvider.authorize({
        email: "user@test.com",
        password: "pass123",
      });
      expect(result).toBeNull();
    });

    it("returns null when merchant not found in session merchants", async () => {
      mockSettingsFindFirst.mockResolvedValue({
        merchantId: "m_1",
        satsrailApiUrl: "https://api.test.com",
      });
      mockCreateSession.mockResolvedValue({
        merchants: [{ id: "m_other", name: "Other", role: "owner" }],
      });

      const result = await adminProvider.authorize({
        email: "user@test.com",
        password: "pass123",
      });
      expect(result).toBeNull();
    });

    it("returns user when merchant matches", async () => {
      mockSettingsFindFirst.mockResolvedValue({
        merchantId: "m_1",
        satsrailApiUrl: "https://api.test.com",
      });
      mockCreateSession.mockResolvedValue({
        merchants: [
          { id: "m_1", name: "My Shop", role: "owner" },
          { id: "m_2", name: "Other", role: "manager" },
        ],
      });

      const result = await adminProvider.authorize({
        email: "user@test.com",
        password: "pass123",
      });

      expect(result).toEqual({
        id: "m_1",
        email: "user@test.com",
        name: "My Shop",
        role: "owner",
        type: "admin",
      });
      // The stored URL is a bare origin, so it is normalized before use —
      // createSession appends `/m/sessions`, which needs the `/api/v1` prefix.
      expect(mockCreateSession).toHaveBeenCalledWith(
        "user@test.com",
        "pass123",
        "https://api.test.com/api/v1"
      );
    });

    it("returns null when createSession throws", async () => {
      mockSettingsFindFirst.mockResolvedValue({
        merchantId: "m_1",
        satsrailApiUrl: "https://api.test.com",
      });
      mockCreateSession.mockRejectedValue(new Error("API error"));

      const result = await adminProvider.authorize({
        email: "user@test.com",
        password: "wrong",
      });
      expect(result).toBeNull();
    });
  });

  // --- JWT callback ---

  describe("jwt callback", () => {
    it("sets token fields when user is present", async () => {
      const token = {};
      const user = { id: "u_1", type: "admin" as const, role: "owner" };

      const result = await jwtCallback({ token, user });
      expect(result).toEqual({
        userId: "u_1",
        type: "admin",
        role: "owner",
      });
    });

    it("returns token unchanged when user is not present", async () => {
      const token = { userId: "u_1", type: "admin" as const, role: "owner" };

      const result = await jwtCallback({ token, user: undefined });
      expect(result).toEqual(token);
    });
  });

  // --- Session callback ---

  describe("session callback", () => {
    it("sets session.user fields from token", async () => {
      const session = { user: { id: "", email: "a@b.com" } };
      const token = { userId: "u_1", type: "admin" as const, role: "owner" };

      const result = await sessionCallback({ session, token });
      expect(result.user.id).toBe("u_1");
      expect(result.user.type).toBe("admin");
      expect(result.user.role).toBe("owner");
    });

    it("handles session without user gracefully", async () => {
      const session = { user: null };
      const token = { userId: "u_1", type: "admin" as const, role: "owner" };

      const result = await sessionCallback({ session, token });
      expect(result).toEqual({ user: null });
    });
  });
});
