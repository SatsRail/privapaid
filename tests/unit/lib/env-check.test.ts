import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("validateEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Set all required env vars
    process.env.DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.SK_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-characters-long";
    process.env.NEXTAUTH_SECRET = "test-auth-secret-at-least-32-characters-long";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("passes with all required env vars set", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const { validateEnv } = await import("@/lib/env-check");
    validateEnv();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits when DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { validateEnv } = await import("@/lib/env-check");
    validateEnv();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("exits when SK_ENCRYPTION_KEY is missing", async () => {
    delete process.env.SK_ENCRYPTION_KEY;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { validateEnv } = await import("@/lib/env-check");
    validateEnv();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when auth secret is missing", async () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { validateEnv } = await import("@/lib/env-check");
    validateEnv();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("accepts AUTH_SECRET alone (without NEXTAUTH_SECRET)", async () => {
    delete process.env.NEXTAUTH_SECRET;
    process.env.AUTH_SECRET = "test-secret-long-enough";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const { validateEnv } = await import("@/lib/env-check");
    validateEnv();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits when SK_ENCRYPTION_KEY is invalid format", async () => {
    process.env.SK_ENCRYPTION_KEY = "not-a-valid-hex-key";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { validateEnv } = await import("@/lib/env-check");
    validateEnv();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("SK_ENCRYPTION_KEY must be a 64-character hex string")
    );
  });
});
