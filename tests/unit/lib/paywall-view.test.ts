import { describe, it, expect } from "vitest";
import { resolvePaywallView } from "@/lib/paywall-view";
import type { MediaAccess } from "@/lib/use-media-access";

const loading: MediaAccess = { status: "loading" };
const active: MediaAccess = {
  status: "active",
  productId: "p1",
  key: "k",
  remainingSeconds: 3600,
  encryptedBlob: "blob",
};
function inactive(
  reason: "no_cookie" | "portal_rejected" | "transient" | "not_checked",
  extra?: { expiredAt?: Date; expiredProductId?: string }
): MediaAccess {
  return { status: "inactive", reason, ...extra };
}

describe("resolvePaywallView", () => {
  describe("content wins over everything", () => {
    it("returns content when bytes are decrypted, regardless of access state", () => {
      for (const access of [loading, active, inactive("transient"), inactive("portal_rejected")]) {
        expect(
          resolvePaywallView({ hasDecryptedContent: true, access, hasUnlockFailure: false })
        ).toEqual({ kind: "content" });
      }
    });

    it("content beats a pending unlock failure", () => {
      expect(
        resolvePaywallView({ hasDecryptedContent: true, access: active, hasUnlockFailure: true })
      ).toEqual({ kind: "content" });
    });
  });

  describe("unlock_failure", () => {
    it("shows when a post-payment failure is pending and no content yet", () => {
      expect(
        resolvePaywallView({ hasDecryptedContent: false, access: active, hasUnlockFailure: true })
      ).toEqual({ kind: "unlock_failure" });
    });

    it("beats a transient verify failure (unlock failure is the more specific state)", () => {
      expect(
        resolvePaywallView({
          hasDecryptedContent: false,
          access: inactive("transient"),
          hasUnlockFailure: true,
        })
      ).toEqual({ kind: "unlock_failure" });
    });
  });

  describe("verify_failure", () => {
    it("shows for an inactive+transient access with no content and no unlock failure", () => {
      expect(
        resolvePaywallView({
          hasDecryptedContent: false,
          access: inactive("transient"),
          hasUnlockFailure: false,
        })
      ).toEqual({ kind: "verify_failure" });
    });
  });

  describe("buttons (the paywall)", () => {
    it.each(["no_cookie", "portal_rejected", "not_checked"] as const)(
      "shows for inactive reason=%s",
      (reason) => {
        expect(
          resolvePaywallView({
            hasDecryptedContent: false,
            access: inactive(reason),
            hasUnlockFailure: false,
          })
        ).toEqual({ kind: "buttons" });
      }
    );

    it("shows buttons for an expired macaroon (the renewal banner rides inside this surface)", () => {
      expect(
        resolvePaywallView({
          hasDecryptedContent: false,
          access: inactive("portal_rejected", {
            expiredAt: new Date("2026-05-01T00:00:00Z"),
            expiredProductId: "p1",
          }),
          hasUnlockFailure: false,
        })
      ).toEqual({ kind: "buttons" });
    });
  });

  describe("checking", () => {
    it("shows while loading", () => {
      expect(
        resolvePaywallView({ hasDecryptedContent: false, access: loading, hasUnlockFailure: false })
      ).toEqual({ kind: "checking" });
    });

    it("shows for active-but-not-yet-decrypted (no content, no failure)", () => {
      expect(
        resolvePaywallView({ hasDecryptedContent: false, access: active, hasUnlockFailure: false })
      ).toEqual({ kind: "checking" });
    });
  });
});
