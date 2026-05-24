import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "@/../tests/helpers/mongodb";
import Settings from "@/models/Settings";
import { encryptSecretKey } from "@/lib/encryption";
import { checkEncryptionKeyMatchesDb } from "@/lib/startup-checks";

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
