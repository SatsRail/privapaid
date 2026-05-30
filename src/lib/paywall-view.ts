import type { MediaAccess } from "@/lib/use-media-access";

/**
 * The mutually-exclusive surfaces PaymentWall can render. Splitting this out
 * of the component gives one place where the whole "which view?" decision —
 * and its precedence — lives, so the next person doesn't have to reconstruct
 * it from nested ternaries spread across the render body.
 *
 *   content        decrypted bytes are ready → render the media itself
 *   unlock_failure paid, but decryption/claim failed ("you paid, it broke")
 *   verify_failure transient portal failure ("couldn't verify, try again")
 *   buttons        definitively no access → the paywall (expired-renewal
 *                  banner, when present, rides inside this surface)
 *   checking       still verifying, or active-but-mid-decrypt → neutral spinner
 */
export type PaywallView =
  | { kind: "content" }
  | { kind: "unlock_failure" }
  | { kind: "verify_failure" }
  | { kind: "buttons" }
  | { kind: "checking" };

export interface PaywallViewInput {
  /** True once content has been decrypted into displayable bytes. */
  hasDecryptedContent: boolean;
  /** Access state from the useMediaAccess hook. */
  access: MediaAccess;
  /** True when a post-payment unlock/decrypt failure card is pending. */
  hasUnlockFailure: boolean;
}

/**
 * Single source of truth for which surface PaymentWall shows. The order of the
 * checks IS the precedence — higher wins:
 *
 *   1. content        — once we can render the media, nothing else matters.
 *   2. unlock_failure  — a confirmed post-payment failure owns the screen.
 *   3. verify_failure  — only a transient (not definitive) portal miss.
 *   4. buttons         — definitively inactive → the viewer has no access.
 *   5. checking        — loading, or active-but-not-yet-decrypted.
 *
 * Pure and total over MediaAccess; never throws.
 */
export function resolvePaywallView({
  hasDecryptedContent,
  access,
  hasUnlockFailure,
}: PaywallViewInput): PaywallView {
  if (hasDecryptedContent) return { kind: "content" };
  if (hasUnlockFailure) return { kind: "unlock_failure" };
  if (access.status === "inactive" && access.reason === "transient") {
    return { kind: "verify_failure" };
  }
  if (access.status === "inactive") return { kind: "buttons" };
  // Only "loading" and "active" (without decrypted content) remain.
  return { kind: "checking" };
}
