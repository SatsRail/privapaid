import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { setupTestDB, teardownTestDB, clearCollections } from "@/../tests/helpers/mongodb";
import Settings from "@/models/Settings";
import { encryptSecretKey } from "@/lib/encryption";
import { checkEncryptionKeyMatchesDb } from "@/lib/startup-checks";
import * as mongodb from "@/lib/mongodb";

describe("startup-checks", () => {
  const originalKey = process.env.SK_ENCRYPTION_KEY;

  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
    process.env.SK_ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    await clearCollections();
    process.env.SK_ENCRYPTION_KEY = originalKey;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("no-ops when no Settings document exists", async () => {
    await expect(checkEncryptionKeyMatchesDb()).resolves.toBeUndefined();
  });

  it("no-ops when Settings has no encrypted key", async () => {
    await Settings.create({ instance_name: "Test" });
    await expect(checkEncryptionKeyMatchesDb()).resolves.toBeUndefined();
  });

  it("succeeds when the encrypted key decrypts with current SK_ENCRYPTION_KEY", async () => {
    const encrypted = encryptSecretKey("sk_live_real");
    await Settings.create({
      instance_name: "Test",
      satsrail_api_key_encrypted: encrypted,
    });
    await expect(checkEncryptionKeyMatchesDb()).resolves.toBeUndefined();
  });

  it("warns and does NOT exit in non-production when the key mismatches", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const encrypted = encryptSecretKey("sk_live_real");
    await Settings.create({
      instance_name: "Test",
      satsrail_api_key_encrypted: encrypted,
    });

    // Rotate the key — the existing ciphertext can no longer be decrypted.
    process.env.SK_ENCRYPTION_KEY =
      "f".repeat(64);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit was called");
    });

    await checkEncryptionKeyMatchesDb();

    expect(exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls.flat().join(" ");
    expect(msg).toContain("SK_ENCRYPTION_KEY does not decrypt");
  });

  it("warns and bails out when MongoDB is unreachable at startup", async () => {
    // Force the "mongoose not connected" branch by stubbing readyState != 1,
    // then make connectDB() reject. The probe should swallow the error and
    // log a warning instead of crashing — boot should not be blocked by a
    // momentarily unreachable database.
    const original = mongoose.connection.readyState;
    Object.defineProperty(mongoose.connection, "readyState", {
      configurable: true,
      get: () => 0, // 0 = disconnected
    });
    const connectSpy = vi
      .spyOn(mongodb, "connectDB")
      .mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:27017"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(checkEncryptionKeyMatchesDb()).resolves.toBeUndefined();
      expect(connectSpy).toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.flat().join(" ")).toContain(
        "MongoDB unreachable, skipping encryption-key probe"
      );
    } finally {
      Object.defineProperty(mongoose.connection, "readyState", {
        configurable: true,
        value: original,
        writable: true,
      });
    }
  });

  it("logs a non-Error rejection from connectDB without crashing", async () => {
    // Same branch as above but exercising the `err instanceof Error ? ... : err`
    // ternary's else side — connectDB rejects with a plain string.
    const original = mongoose.connection.readyState;
    Object.defineProperty(mongoose.connection, "readyState", {
      configurable: true,
      get: () => 0,
    });
    vi.spyOn(mongodb, "connectDB").mockRejectedValue("kaboom");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(checkEncryptionKeyMatchesDb()).resolves.toBeUndefined();
      // The non-Error branch passes the raw value through.
      expect(warn.mock.calls.flat()).toContain("kaboom");
    } finally {
      Object.defineProperty(mongoose.connection, "readyState", {
        configurable: true,
        value: original,
        writable: true,
      });
    }
  });

  it("logs a non-Error decrypt failure in non-production", async () => {
    // Cover the `err instanceof Error ? err.message : err` else side in the
    // decrypt-failure path. Stub decryptSecretKey to throw a plain string.
    vi.stubEnv("NODE_ENV", "development");
    const encrypted = encryptSecretKey("sk_live_real");
    await Settings.create({
      instance_name: "Test",
      satsrail_api_key_encrypted: encrypted,
    });

    const encryption = await import("@/lib/encryption");
    vi.spyOn(encryption, "decryptSecretKey").mockImplementation(() => {
      throw "string-error";
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await checkEncryptionKeyMatchesDb();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat()).toContain("string-error");
  });

  it("exits in production when the key mismatches", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const encrypted = encryptSecretKey("sk_live_real");
    await Settings.create({
      instance_name: "Test",
      satsrail_api_key_encrypted: encrypted,
    });

    process.env.SK_ENCRYPTION_KEY = "f".repeat(64);

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(((..._args: unknown[]) => {
        throw new Error("process.exit was called");
      }) as never);

    await expect(checkEncryptionKeyMatchesDb()).rejects.toThrow(
      "process.exit was called"
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.flat().join(" ")).toContain(
      "SK_ENCRYPTION_KEY does not decrypt"
    );
  });
});
