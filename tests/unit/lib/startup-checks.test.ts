import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createSettings, createChannel, createMedia } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";
import { encryptSecretKey } from "@/lib/encryption";
import {
  checkEncryptionKeyMatchesDb,
  warnOnBrokenMediaEnvelopes,
} from "@/lib/startup-checks";

const WRAPPED_DEK_CONSTRAINT = "MediaEnvelope_linked_has_wrappedDek";

/**
 * Seed the LEGACY broken state: a linked envelope with no wrapped DEK.
 * The CHECK constraint (correctly) forbids creating this via normal writes —
 * such rows only exist because they predate the constraint (NOT VALID skips
 * them) — so the seed drops and re-adds it around the insert.
 */
async function createLegacyEnvelopeWithoutDek(mediaId: string) {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "MediaEnvelope" DROP CONSTRAINT "${WRAPPED_DEK_CONSTRAINT}"`
  );
  try {
    await prisma.mediaEnvelope.create({
      data: { mediaId, bytes: Buffer.from([0x01]), mimeType: "text/url" },
    });
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "MediaEnvelope" ADD CONSTRAINT "${WRAPPED_DEK_CONSTRAINT}"
       CHECK ("mediaId" IS NULL OR "wrappedDek" IS NOT NULL) NOT VALID`
    );
  }
}

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

  it("no-ops when no Settings row exists", async () => {
    await expect(checkEncryptionKeyMatchesDb()).resolves.toBeUndefined();
  });

  it("no-ops when Settings has no encrypted key", async () => {
    await createSettings({ instanceName: "Test" });
    await expect(checkEncryptionKeyMatchesDb()).resolves.toBeUndefined();
  });

  it("succeeds when the encrypted key decrypts with current SK_ENCRYPTION_KEY", async () => {
    const encrypted = encryptSecretKey("sk_live_real");
    await createSettings({ instanceName: "Test", satsrailApiKeyEncrypted: encrypted });
    await expect(checkEncryptionKeyMatchesDb()).resolves.toBeUndefined();
  });

  it("warns and does NOT exit in non-production when the key mismatches", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const encrypted = encryptSecretKey("sk_live_real");
    await createSettings({ instanceName: "Test", satsrailApiKeyEncrypted: encrypted });

    // Rotate the key — the existing ciphertext can no longer be decrypted.
    process.env.SK_ENCRYPTION_KEY = "f".repeat(64);

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

  it("warns and bails out when Postgres is unreachable at startup", async () => {
    const findFirstSpy = vi
      .spyOn(prisma.settings, "findFirst")
      .mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:5432"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(checkEncryptionKeyMatchesDb()).resolves.toBeUndefined();
    expect(findFirstSpy).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain(
      "Postgres unreachable, skipping encryption-key probe"
    );
  });

  it("logs a non-Error rejection from findFirst without crashing", async () => {
    vi.spyOn(prisma.settings, "findFirst").mockRejectedValue("kaboom");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(checkEncryptionKeyMatchesDb()).resolves.toBeUndefined();
    expect(warn.mock.calls.flat()).toContain("kaboom");
  });

  it("logs a non-Error decrypt failure in non-production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const encrypted = encryptSecretKey("sk_live_real");
    await createSettings({ instanceName: "Test", satsrailApiKeyEncrypted: encrypted });

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
    await createSettings({ instanceName: "Test", satsrailApiKeyEncrypted: encrypted });

    process.env.SK_ENCRYPTION_KEY = "f".repeat(64);

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
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

  describe("warnOnBrokenMediaEnvelopes", () => {
    it("stays silent when every media has a healthy envelope", async () => {
      const channel = await createChannel();
      await createMedia(channel.id);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await warnOnBrokenMediaEnvelopes();

      expect(warn).not.toHaveBeenCalled();
    });

    it("warns when a media has no envelope at all", async () => {
      const channel = await createChannel();
      // Bypass the factory (it always mints an envelope) — this is the
      // broken state the probe exists to catch.
      await prisma.media.create({
        data: { channelId: channel.id, name: "envelope-less", mediaType: "video" },
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await warnOnBrokenMediaEnvelopes();

      expect(warn).toHaveBeenCalled();
      const msg = warn.mock.calls.flat().join(" ");
      expect(msg).toContain("1 without an envelope");
      expect(msg).toContain("audit-media-envelopes");
    });

    it("warns when a linked envelope is missing its wrapped DEK (legacy url media)", async () => {
      const channel = await createChannel();
      const media = await prisma.media.create({
        data: { channelId: channel.id, name: "legacy-url", mediaType: "video" },
      });
      await createLegacyEnvelopeWithoutDek(media.id);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await warnOnBrokenMediaEnvelopes();

      const msg = warn.mock.calls.flat().join(" ");
      expect(msg).toContain("1 without a wrapped DEK");
    });

    it("adds the CONTENT_KEK warning only when broken media exist AND the KEK is unset", async () => {
      vi.stubEnv("CONTENT_KEK", "");
      const channel = await createChannel();
      await prisma.media.create({
        data: { channelId: channel.id, name: "envelope-less", mediaType: "video" },
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await warnOnBrokenMediaEnvelopes();

      const msg = warn.mock.calls.flat().join(" ");
      expect(msg).toContain("CONTENT_KEK is not set");
    });

    it("warns and bails out when Postgres is unreachable — never blocks boot", async () => {
      vi.spyOn(prisma.media, "count").mockRejectedValue(
        new Error("ECONNREFUSED 127.0.0.1:5432")
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(warnOnBrokenMediaEnvelopes()).resolves.toBeUndefined();
      expect(warn.mock.calls.flat().join(" ")).toContain(
        "skipping media-envelope probe"
      );
    });
  });

  describe("MediaEnvelope_linked_has_wrappedDek constraint", () => {
    it("rejects creating a NEW linked envelope without a wrapped DEK", async () => {
      const channel = await createChannel();
      const media = await prisma.media.create({
        data: { channelId: channel.id, name: "m", mediaType: "video" },
      });

      await expect(
        prisma.mediaEnvelope.create({
          data: { mediaId: media.id, bytes: Buffer.from([0x01]), mimeType: "text/url" },
        })
      ).rejects.toThrow();
    });

    it("allows a STAGED envelope (no mediaId) without a wrapped DEK", async () => {
      // Photo uploads stage the envelope before the Media row exists; only
      // LINKING without a DEK is forbidden.
      await expect(
        prisma.mediaEnvelope.create({
          data: { bytes: Buffer.from([0x01]), mimeType: "image/jpeg" },
        })
      ).resolves.toBeTruthy();
    });
  });
});
