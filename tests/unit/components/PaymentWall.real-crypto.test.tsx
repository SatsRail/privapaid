// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createHash, randomBytes, webcrypto } from "crypto";
import { encryptSourceUrl, encryptBytes } from "@/lib/content-encryption";
import {
  bytesToBase64url,
  genProductKey,
  sha256HexOfString,
} from "../../helpers/crypto";
import { mockFetch } from "../../helpers/fetch";
import type { MediaAccess } from "@/lib/use-media-access";

/**
 * PaymentWall with REAL crypto.
 *
 * The unit-level PaymentWall.test.tsx mocks `decryptBlob` and
 * `verifyKeyFingerprint` away — great for testing the component's branching
 * but useless for catching bugs in HOW PaymentWall threads keys, AAD, and
 * bytes through the decryption pipeline.
 *
 * This file is the only place that exercises:
 *   - Real `decryptBlob` (with productId AAD) for non-photo media
 *   - Real photo envelope unwrap (decryptBlob → DEK → fetch GridFS → decryptBytesWithKey)
 *   - Real `verifyKeyFingerprint` SHA-256 contract
 *   - Real React state transitions through onAccessClaim → decryption effect
 *
 * If anything drifts between the server-side encrypt path and what
 * PaymentWall expects at decrypt time, this file fails loudly with the
 * actual bytes that came out.
 */

// ── jsdom needs webcrypto.subtle wired in ─────────────────────────────
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
}

// ── Mocks (intentionally do NOT mock @/lib/client-crypto) ─────────────

const mockSession = { data: null, status: "unauthenticated" as const };
vi.mock("next-auth/react", () => ({ useSession: () => mockSession }));

const mockCaptureException = vi.fn();
const mockCaptureMessage = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

vi.mock("@/i18n/useLocale", async () => {
  const { t: realT } = await import("@/i18n");
  return { useLocale: () => ({ t: (k: string, p?: Record<string, string | number>) => realT("en", k, p), locale: "en" }) };
});

vi.mock("@/components/ui/Button", () => ({
  default: ({ children, onClick, loading, className }: {
    children: React.ReactNode; onClick?: () => void; loading?: boolean; className?: string;
  }) => (
    <button onClick={onClick} disabled={loading} className={className} data-testid="unlock-btn">{children}</button>
  ),
}));

// Capture decryptedBytes via the ContentRenderer mock so the test can
// assert byte-equality with the original plaintext.
let capturedDecryptedBytes: Uint8Array | null = null;
vi.mock("@/components/ContentRenderer", () => ({
  default: ({ decryptedBytes, mediaType }: { decryptedBytes: Uint8Array; mediaType: string }) => {
    capturedDecryptedBytes = decryptedBytes;
    return <div data-testid="content-renderer" data-media-type={mediaType}>{decryptedBytes.length}</div>;
  },
}));

vi.mock("@/components/ExchangeModal", () => ({
  default: () => null,
}));

/**
 * Test fixture for the checkout-completion payload. Each test calls
 * `checkoutFixture.arm(...)` BEFORE `user.click("complete-btn")` to declare
 * what the mocked CheckoutOverlay should fire as `onComplete`.
 */
interface CompletionPayload {
  key: string;
  macaroon: string;
  order_number: string | null;
  order_id: string | null;
  remaining_seconds?: number;
}
const EMPTY_COMPLETION: CompletionPayload = {
  key: "",
  macaroon: "",
  order_number: null,
  order_id: null,
};
const checkoutFixture = {
  next: EMPTY_COMPLETION as CompletionPayload,
  arm(payload: CompletionPayload) {
    this.next = payload;
  },
  reset() {
    this.next = EMPTY_COMPLETION;
  },
};

vi.mock("@/components/CheckoutOverlay", () => ({
  default: ({ onComplete }: {
    onComplete: (data: CompletionPayload) => void;
  }) => (
    <div data-testid="checkout-overlay">
      <button
        data-testid="complete-btn"
        onClick={() => onComplete({ ...checkoutFixture.next })}
      >
        Complete
      </button>
    </div>
  ),
}));

import PaymentWall from "@/components/PaymentWall";

const NO_ACCESS: MediaAccess = { status: "inactive", reason: "no_cookie" };

/**
 * Stateful wrapper mirroring the real MediaLayout's useMediaAccess
 * integration: when PaymentWall calls onAccessClaim, transition the access
 * prop to `active` with that payload. This is the real handoff the parent
 * hook performs in production.
 */
function StatefulPaymentWall({
  initialAccess = NO_ACCESS,
  ...props
}: Omit<React.ComponentProps<typeof PaymentWall>, "access" | "onAccessClaim"> & {
  initialAccess?: MediaAccess;
}) {
  const [access, setAccess] = useState<MediaAccess>(initialAccess);
  return (
    <PaymentWall
      {...props}
      access={access}
      onAccessClaim={(p) =>
        setAccess({
          status: "active",
          productId: p.productId,
          key: p.key,
          remainingSeconds: p.remainingSeconds,
          encryptedBlob: p.encryptedBlob,
        })
      }
    />
  );
}

// ── Helpers ───────────────────────────────────────────────────────────
const PRODUCT_ID = "550e8400-e29b-41d4-a716-446655440000";

// ── Tests ─────────────────────────────────────────────────────────────

describe("PaymentWall with real crypto", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedDecryptedBytes = null;
    checkoutFixture.reset();
    mockFetch(() => undefined); // unmatched routes 404
  });

  // -------------------------------------------------------------------
  // POST-PAYMENT — handleCheckoutComplete → onAccessClaim → decrypt effect
  // -------------------------------------------------------------------

  it("article post-payment: real decryptBlob recovers the EXACT original markdown", async () => {
    const user = userEvent.setup();

    const articleBody = [
      "# Lightning in a bottle",
      "",
      "Markdown body with **emphasis** and unicode: café 中文 🔥.",
      "",
      "- bullet one",
      "- [link](https://example.com)",
    ].join("\n");

    const productKey = genProductKey();
    const fingerprint = await sha256HexOfString(productKey);
    const encryptedBlob = encryptSourceUrl(articleBody, productKey, PRODUCT_ID);
    const expectedBytes = new TextEncoder().encode(articleBody);

    const products = [{
      productId: PRODUCT_ID,
      encryptedBlob,
      keyFingerprint: fingerprint,
      name: "Article",
      priceCents: 1,
      currency: "USD",
      accessDurationSeconds: 86400,
      status: "active",
    }];

    mockFetch((url, opts) => {
      if (url === "/api/checkout" && opts?.method === "POST") {
        return { ok: true, json: async () => ({ token: "tok" }) };
      }
      if (url === "/api/macaroons" && opts?.method === "POST") {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    checkoutFixture.arm({
      key: productKey,
      macaroon: "macaroon-token-xyz",
      order_number: "ORD-REALCRYPTO-ART",
      order_id: "uuid-real-art",
      remaining_seconds: 86400,
    });

    render(
      <StatefulPaymentWall
        mediaId="media-article-1"
        products={products}
        mediaType="article"
      />
    );

    await waitFor(() => expect(screen.getAllByText(/Article/)[0]).toBeInTheDocument());
    await user.click(screen.getAllByText(/Article/)[0]);
    await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
    await user.click(screen.getByTestId("complete-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
    });

    // The decrypted bytes passed to ContentRenderer MUST equal the original
    // article body bytes, byte-for-byte. This is the strongest end-to-end
    // unit-level guarantee for the article path.
    expect(capturedDecryptedBytes).not.toBeNull();
    expect(capturedDecryptedBytes!.length).toBe(expectedBytes.length);
    expect(Buffer.from(capturedDecryptedBytes!).equals(Buffer.from(expectedBytes))).toBe(true);

    // And no failure events were fired.
    expect(mockCaptureMessage).not.toHaveBeenCalledWith(
      "PaymentWall.recordFailure",
      expect.anything()
    );
  });

  it("photo post-payment: real envelope unwrap recovers the EXACT original image bytes", async () => {
    const user = userEvent.setup();

    const originalPhoto = Buffer.from(
      Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        ...Buffer.from("REAL-CRYPTO-PHOTO-PAYLOAD-DATA"),
      ])
    );
    const dek = randomBytes(32);
    const gridFsCiphertext = encryptBytes(originalPhoto, dek);
    const gridFsId = "gridfs-real-crypto-photo";

    const dekBase64url = bytesToBase64url(dek);

    const productKey = genProductKey();
    const fingerprint = await sha256HexOfString(productKey);
    const wrappedDek = encryptSourceUrl(dekBase64url, productKey, PRODUCT_ID);

    const products = [{
      productId: PRODUCT_ID,
      encryptedBlob: wrappedDek,
      keyFingerprint: fingerprint,
      name: "Photo",
      priceCents: 1,
      currency: "USD",
      accessDurationSeconds: 86400,
      status: "active",
    }];

    mockFetch((url, opts) => {
      if (url === "/api/checkout" && opts?.method === "POST") {
        return { ok: true, json: async () => ({ token: "tok" }) };
      }
      if (url === "/api/macaroons" && opts?.method === "POST") {
        return { ok: true, json: async () => ({}) };
      }
      if (url === `/api/photos/${gridFsId}`) {
        return {
          ok: true,
          arrayBuffer: async () => gridFsCiphertext.buffer.slice(
            gridFsCiphertext.byteOffset,
            gridFsCiphertext.byteOffset + gridFsCiphertext.byteLength
          ),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    checkoutFixture.arm({
      key: productKey,
      macaroon: "macaroon-photo-xyz",
      order_number: "ORD-REALCRYPTO-PHOTO",
      order_id: "uuid-real-photo",
      remaining_seconds: 86400,
    });

    render(
      <StatefulPaymentWall
        mediaId="media-photo-1"
        products={products}
        mediaType="photo"
        photoGridFsId={gridFsId}
      />
    );

    await waitFor(() => expect(screen.getAllByText(/Photo/)[0]).toBeInTheDocument());
    await user.click(screen.getAllByText(/Photo/)[0]);
    await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
    await user.click(screen.getByTestId("complete-btn"));

    await waitFor(() => expect(screen.getByTestId("content-renderer")).toBeInTheDocument());

    expect(capturedDecryptedBytes).not.toBeNull();
    expect(capturedDecryptedBytes!.length).toBe(originalPhoto.length);
    expect(Buffer.from(capturedDecryptedBytes!).equals(originalPhoto)).toBe(true);
  });

  // -------------------------------------------------------------------
  // PAGE RELOAD AFTER PAYMENT — access prop arrives pre-active from the parent
  // -------------------------------------------------------------------
  // In the new architecture, the parent's useMediaAccess hook runs the
  // unlock check at mount; PaymentWall receives the already-active access
  // prop and just needs to decrypt. These tests pin that we correctly
  // decrypt under the most common "returning visitor" scenario.

  it("article page reload after payment: active access prop → real decrypt recovers the article", async () => {
    const articleBody = "Article body after a page reload.";
    const productKey = genProductKey();
    const fingerprint = await sha256HexOfString(productKey);
    const encryptedBlob = encryptSourceUrl(articleBody, productKey, PRODUCT_ID);
    const expectedBytes = new TextEncoder().encode(articleBody);

    const products = [{
      productId: PRODUCT_ID,
      encryptedBlob,
      keyFingerprint: fingerprint,
      name: "Reloaded Article",
      priceCents: 1,
      currency: "USD",
      accessDurationSeconds: 86400,
      status: "active",
    }];

    render(
      <PaymentWall
        mediaId="media-reload-article"
        products={products}
        access={{
          status: "active",
          productId: PRODUCT_ID,
          key: productKey,
          remainingSeconds: 86400,
          encryptedBlob,
        }}
        onAccessClaim={() => {}}
        mediaType="article"
      />
    );

    await waitFor(() => expect(screen.getByTestId("content-renderer")).toBeInTheDocument());

    expect(capturedDecryptedBytes).not.toBeNull();
    expect(Buffer.from(capturedDecryptedBytes!).equals(Buffer.from(expectedBytes))).toBe(true);
  });

  it("photo page reload after payment: active access prop → envelope unwrap → real photo bytes", async () => {
    const originalPhoto = Buffer.from(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...Buffer.from("RELOAD-PHOTO")])
    );
    const dek = randomBytes(32);
    const gridFsCiphertext = encryptBytes(originalPhoto, dek);
    const gridFsId = "gridfs-reload-photo";
    const dekBase64url = bytesToBase64url(dek);
    const productKey = genProductKey();
    const fingerprint = await sha256HexOfString(productKey);
    const wrappedDek = encryptSourceUrl(dekBase64url, productKey, PRODUCT_ID);

    const products = [{
      productId: PRODUCT_ID,
      encryptedBlob: wrappedDek,
      keyFingerprint: fingerprint,
      name: "Reloaded Photo",
      priceCents: 1,
      currency: "USD",
      accessDurationSeconds: 86400,
      status: "active",
    }];

    mockFetch((url) => {
      if (url === `/api/photos/${gridFsId}`) {
        return {
          ok: true,
          arrayBuffer: async () => gridFsCiphertext.buffer.slice(
            gridFsCiphertext.byteOffset,
            gridFsCiphertext.byteOffset + gridFsCiphertext.byteLength
          ),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    render(
      <PaymentWall
        mediaId="media-reload-photo"
        products={products}
        access={{
          status: "active",
          productId: PRODUCT_ID,
          key: productKey,
          remainingSeconds: 86400,
          encryptedBlob: wrappedDek,
        }}
        onAccessClaim={() => {}}
        mediaType="photo"
        photoGridFsId={gridFsId}
      />
    );

    await waitFor(() => expect(screen.getByTestId("content-renderer")).toBeInTheDocument());
    expect(Buffer.from(capturedDecryptedBytes!).equals(originalPhoto)).toBe(true);
  });

  // -------------------------------------------------------------------
  // ADVERSARIAL PORTAL RESPONSES — key shapes a real portal might return
  // -------------------------------------------------------------------

  it("article: trailing newline on portal key fails LOUDLY at the fingerprint check", async () => {
    // If the portal accidentally returns the key with a trailing newline,
    // the SHA-256 of the corrupted string won't match the stored fingerprint.
    // The fingerprint check must catch this so we don't silently decrypt to
    // garbage. The recordFailure Sentry event then surfaces the branch.
    const articleBody = "Tolerance test";
    const productKey = genProductKey();
    const corruptedKey = productKey + "\n";
    const fingerprint = await sha256HexOfString(productKey);
    const encryptedBlob = encryptSourceUrl(articleBody, productKey, PRODUCT_ID);

    const products = [{
      productId: PRODUCT_ID,
      encryptedBlob,
      keyFingerprint: fingerprint,
      name: "Adversarial",
      priceCents: 1,
      currency: "USD",
      accessDurationSeconds: 86400,
      status: "active",
    }];

    const user = userEvent.setup();
    mockFetch((url, opts) => {
      if (url === "/api/checkout" && opts?.method === "POST") {
        return { ok: true, json: async () => ({ token: "tok" }) };
      }
      if (url === "/api/macaroons" && opts?.method === "POST") {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    checkoutFixture.arm({
      key: corruptedKey,
      macaroon: "macaroon-adv",
      order_number: "ORD-ADV",
      order_id: "uuid-adv",
    });

    render(
      <StatefulPaymentWall
        mediaId="media-adv"
        products={products}
        mediaType="article"
      />
    );

    await waitFor(() => expect(screen.getAllByText(/Adversarial/)[0]).toBeInTheDocument());
    await user.click(screen.getAllByText(/Adversarial/)[0]);
    await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
    await user.click(screen.getByTestId("complete-btn"));

    await waitFor(() => {
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        "PaymentWall.recordFailure",
        expect.objectContaining({
          tags: expect.objectContaining({
            context: "PaymentWall.recordFailure",
            reason: "fingerprintMismatch",
          }),
        })
      );
    });
    expect(screen.queryByTestId("content-renderer")).not.toBeInTheDocument();
  });

  it("fingerprint contract: server SHA-256(key) matches client SHA-256(key) exactly", async () => {
    // Pin the fingerprint algorithm contract end-to-end. If portal Ruby
    // (Digest::SHA256.hexdigest(key)) ever drifts from the client
    // (SHA-256 of UTF-8 bytes of key, hex), every paying customer would
    // see PaymentWall.fingerprint failures.
    const k = genProductKey();
    const clientFp = await sha256HexOfString(k);

    const serverFp = createHash("sha256").update(k).digest("hex");
    expect(clientFp).toBe(serverFp);
  });
});
