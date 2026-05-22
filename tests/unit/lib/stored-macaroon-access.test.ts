/**
 * Focused unit specs for `checkStoredMacaroonAccess`.
 *
 * The function is the mount-time access check PaymentWall runs on every
 * page load. It encapsulates a two-step "verify stored macaroon, then
 * fall back to direct unlock" flow and returns one of three discriminated
 * outcomes. These specs exercise each branch through real fetch mocks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockFetch } from "../../helpers/fetch";

vi.mock("@/lib/client-crypto", () => ({
  verifyKeyFingerprint: vi.fn().mockResolvedValue(true),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

import { verifyKeyFingerprint } from "@/lib/client-crypto";
import { checkStoredMacaroonAccess } from "@/lib/stored-macaroon-access";

const mockVerifyKeyFingerprint = vi.mocked(verifyKeyFingerprint);

const PRODUCT = {
  productId: "prod-1",
  encryptedBlob: "blob-A",
  keyFingerprint: "fp-1",
};

const DECRYPTED = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const resolveContent = vi.fn(async () => DECRYPTED);

const baseArgs = {
  mediaId: "media-1",
  products: [PRODUCT],
  storedProductIds: ["prod-1"],
  resolveContent,
};

describe("checkStoredMacaroonAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyKeyFingerprint.mockResolvedValue(true);
    resolveContent.mockResolvedValue(DECRYPTED);
  });

  it("returns `unlocked` when a stored macaroon verifies and content decrypts", async () => {
    mockFetch((url, init) => {
      if (url === "/api/macaroons" && init?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            key: "key-from-portal",
            key_fingerprint: "fp-1",
            remaining_seconds: 3600,
          }),
        };
      }
    });

    const outcome = await checkStoredMacaroonAccess(baseArgs);

    expect(outcome.kind).toBe("unlocked");
    if (outcome.kind === "unlocked") {
      expect(outcome.productId).toBe("prod-1");
      expect(outcome.bytes).toBe(DECRYPTED);
      expect(outcome.remainingSeconds).toBe(3600);
    }
    expect(resolveContent).toHaveBeenCalledWith("blob-A", "key-from-portal", "prod-1");
  });

  it("returns `no_access` when there's no stored macaroon and no fallback unlock", async () => {
    mockFetch(() => undefined); // every fetch falls through to 404

    const outcome = await checkStoredMacaroonAccess({
      ...baseArgs,
      storedProductIds: [],
    });

    expect(outcome.kind).toBe("no_access");
    expect(resolveContent).not.toHaveBeenCalled();
  });

  it("returns `transient_failure` when the verify endpoint returns 502", async () => {
    mockFetch((url, init) => {
      if (url === "/api/macaroons" && init?.method === "PUT") {
        return { ok: false, status: 502, json: async () => ({}) };
      }
    });

    const outcome = await checkStoredMacaroonAccess(baseArgs);
    expect(outcome.kind).toBe("transient_failure");
  });

  it("returns `no_access` (NOT transient) when verify returns 410 — cookie was cleaned", async () => {
    // 410 is the portal's signal that the macaroon is definitively dead.
    // We let the user see the pay buttons rather than a "couldn't verify"
    // card because their macaroon really is gone.
    mockFetch((url, init) => {
      if (url === "/api/macaroons" && init?.method === "PUT") {
        return { ok: false, status: 410, json: async () => ({}) };
      }
    });

    const outcome = await checkStoredMacaroonAccess(baseArgs);
    expect(outcome.kind).toBe("no_access");
  });

  it("returns `transient_failure` when verify succeeds but the fingerprint mismatches", async () => {
    mockVerifyKeyFingerprint.mockResolvedValue(false);
    mockFetch((url, init) => {
      if (url === "/api/macaroons" && init?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ key: "wrong-key", remaining_seconds: 60 }),
        };
      }
    });

    const outcome = await checkStoredMacaroonAccess(baseArgs);
    expect(outcome.kind).toBe("transient_failure");
    expect(resolveContent).not.toHaveBeenCalled();
  });

  it("falls back to direct unlock when no stored macaroon and unlock succeeds", async () => {
    mockFetch((url) => {
      if (url === "/api/media/media-1/unlock") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            key: "fallback-key",
            key_fingerprint: "fp-1",
            encrypted_blob: "blob-A",
            product_id: "prod-1",
            remaining_seconds: 86400,
          }),
        };
      }
    });

    const outcome = await checkStoredMacaroonAccess({
      ...baseArgs,
      storedProductIds: [],
    });

    expect(outcome.kind).toBe("unlocked");
    if (outcome.kind === "unlocked") {
      expect(outcome.productId).toBe("prod-1");
      expect(outcome.remainingSeconds).toBe(86400);
    }
  });

  it("returns `transient_failure` when the direct unlock endpoint 5xxs", async () => {
    mockFetch((url) => {
      if (url === "/api/media/media-1/unlock") {
        return { ok: false, status: 503, json: async () => ({}) };
      }
    });

    const outcome = await checkStoredMacaroonAccess({
      ...baseArgs,
      storedProductIds: [],
    });
    expect(outcome.kind).toBe("transient_failure");
  });

  it("treats a thrown fetch as a transient failure (network error)", async () => {
    mockFetch((url, init) => {
      if (url === "/api/macaroons" && init?.method === "PUT") {
        throw new Error("network down");
      }
    });

    const outcome = await checkStoredMacaroonAccess(baseArgs);
    expect(outcome.kind).toBe("transient_failure");
  });
});
