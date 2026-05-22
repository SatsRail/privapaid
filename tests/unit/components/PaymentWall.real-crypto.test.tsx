// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
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

/**
 * PaymentWall with REAL crypto.
 *
 * The existing PaymentWall.test.tsx mocks `decryptBlob` and
 * `verifyKeyFingerprint` away — which is great for testing the
 * component's branching but useless for catching bugs in HOW PaymentWall
 * actually threads keys, AAD, and bytes through the decryption pipeline.
 *
 * This file is the only place that exercises:
 *   - Real `decryptBlob` (with productId AAD) for non-photo media
 *   - Real photo envelope unwrap (decryptBlob → DEK → fetch GridFS → decryptBytesWithKey)
 *   - Real `verifyKeyFingerprint` SHA-256 contract
 *   - Real React state transitions (mount checkAccess + post-payment handleCheckoutComplete)
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

vi.mock("@/components/HeartbeatManager", () => ({
  default: () => <div data-testid="heartbeat-manager" />,
}));

vi.mock("@/components/ExchangeModal", () => ({
  default: () => null,
}));

/**
 * Test fixture for the checkout-completion payload. Each test calls
 * `checkoutFixture.arm(...)` BEFORE `user.click("complete-btn")` to declare
 * what the mocked CheckoutOverlay should fire as `onComplete`. Wrapped in
 * an object instead of a free variable so the mutation is obvious at every
 * call site and `beforeEach` can reset it through one named method.
 */
interface CompletionPayload {
  key: string;
  macaroon: string;
  order_number: string | null;
  order_id: string | null;
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
    onComplete: (data: CompletionPayload & { remaining_seconds?: number }) => void;
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

// ── Helpers ───────────────────────────────────────────────────────────
// Shared crypto helpers live in tests/helpers/crypto.ts. The local
// `webcrypto` import above is only retained for the `globalThis.crypto`
// polyfill at the top of this file (jsdom doesn't ship `crypto.subtle`).

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
  // POST-PAYMENT — handleCheckoutComplete with REAL decryptBlob
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

    // Fetch mocks: checkout creation succeeds; everything else 404s so the
    // mount-time checkAccess shows pay buttons (no stored macaroon).
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
    });

    render(
      <PaymentWall
        mediaId="media-article-1"
        products={products}
        storedProductIds={[]}
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
        // Real GridFS bytes — PaymentWall.resolveContent will decrypt these.
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
    });

    render(
      <PaymentWall
        mediaId="media-photo-1"
        products={products}
        storedProductIds={[]}
        mediaType="photo"
        photoGridFsId={gridFsId}
      />
    );

    await waitFor(() => expect(screen.getAllByText(/Photo/)[0]).toBeInTheDocument());
    await user.click(screen.getAllByText(/Photo/)[0]);
    await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
    await user.click(screen.getByTestId("complete-btn"));

    await waitFor(() => expect(screen.getByTestId("content-renderer")).toBeInTheDocument());

    // The bytes after PaymentWall's envelope unwrap MUST equal the original
    // photo bytes exactly. If GridFS fetch, DEK decode, AAD encoding, or
    // any decryption step drifts, this fails.
    expect(capturedDecryptedBytes).not.toBeNull();
    expect(capturedDecryptedBytes!.length).toBe(originalPhoto.length);
    expect(Buffer.from(capturedDecryptedBytes!).equals(originalPhoto)).toBe(true);
  });

  // -------------------------------------------------------------------
  // PAGE RELOAD AFTER PAYMENT — the customer's "still shows pay buttons" case
  // -------------------------------------------------------------------

  it("article page reload after payment: stored macaroon → /api/macaroons PUT → real decrypt recovers the article", async () => {
    // Simulates the customer's likely failure path: they paid in a previous
    // session, came back, the cookie + PUT verify path runs at mount, and
    // must decrypt the article with the real crypto.
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

    mockFetch((url, opts) => {
      if (url === "/api/macaroons" && opts?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            valid: true,
            key: productKey,
            key_fingerprint: fingerprint,
            remaining_seconds: 86400,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    render(
      <PaymentWall
        mediaId="media-reload-article"
        products={products}
        storedProductIds={[PRODUCT_ID]} // simulates server-found stored macaroon
        mediaType="article"
      />
    );

    await waitFor(() => expect(screen.getByTestId("content-renderer")).toBeInTheDocument());

    expect(capturedDecryptedBytes).not.toBeNull();
    expect(Buffer.from(capturedDecryptedBytes!).equals(Buffer.from(expectedBytes))).toBe(true);
  });

  it("photo page reload after payment: stored macaroon → envelope unwrap → real photo bytes", async () => {
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

    mockFetch((url, opts) => {
      if (url === "/api/macaroons" && opts?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            valid: true,
            key: productKey,
            key_fingerprint: fingerprint,
            remaining_seconds: 86400,
          }),
        };
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

    render(
      <PaymentWall
        mediaId="media-reload-photo"
        products={products}
        storedProductIds={[PRODUCT_ID]}
        mediaType="photo"
        photoGridFsId={gridFsId}
      />
    );

    await waitFor(() => expect(screen.getByTestId("content-renderer")).toBeInTheDocument());
    expect(Buffer.from(capturedDecryptedBytes!).equals(originalPhoto)).toBe(true);
  });

  // -------------------------------------------------------------------
  // FALLBACK UNLOCK ENDPOINT — direct decryption fails, fallback succeeds
  // -------------------------------------------------------------------

  it("article: when direct decryption is skipped (empty key), real fallback unlock decrypts correctly", async () => {
    const user = userEvent.setup();
    const articleBody = "Article delivered via fallback unlock endpoint.";
    const productKey = genProductKey();
    const fingerprint = await sha256HexOfString(productKey);
    const encryptedBlob = encryptSourceUrl(articleBody, productKey, PRODUCT_ID);
    const expectedBytes = new TextEncoder().encode(articleBody);

    const products = [{
      productId: PRODUCT_ID,
      encryptedBlob,
      keyFingerprint: fingerprint,
      name: "Fallback Article",
      priceCents: 1,
      currency: "USD",
      accessDurationSeconds: 86400,
      status: "active",
    }];

    // Gate the unlock endpoint to fail during mount-time checkAccess and
    // succeed only after checkout completes (mirrors the real flow: the
    // server-side macaroon cookie isn't set until after the POST).
    let checkoutCompleted = false;
    mockFetch((url, opts) => {
      if (url === "/api/checkout" && opts?.method === "POST") {
        return { ok: true, json: async () => ({ token: "tok" }) };
      }
      if (url === "/api/macaroons" && opts?.method === "POST") {
        checkoutCompleted = true; // set just before handleCheckoutComplete fires the fallback
        return { ok: true, json: async () => ({}) };
      }
      if (url === "/api/media/media-fallback-article/unlock") {
        if (!checkoutCompleted) return { ok: false, status: 401, json: async () => ({}) };
        return {
          ok: true,
          json: async () => ({
            key: productKey,
            key_fingerprint: fingerprint,
            encrypted_blob: encryptedBlob,
            product_id: PRODUCT_ID,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    // Portal returned macaroon but NO key — forces fallback.
    checkoutFixture.arm({
      key: "",
      macaroon: "macaroon-fallback",
      order_number: "ORD-FALLBACK-ART",
      order_id: "uuid-fallback-art",
    });

    render(
      <PaymentWall
        mediaId="media-fallback-article"
        products={products}
        storedProductIds={[]}
        mediaType="article"
      />
    );

    await waitFor(() => expect(screen.getAllByText(/Article/)[0]).toBeInTheDocument());
    await user.click(screen.getAllByText(/Article/)[0]);
    await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
    await user.click(screen.getByTestId("complete-btn"));

    await waitFor(() => expect(screen.getByTestId("content-renderer")).toBeInTheDocument());
    expect(Buffer.from(capturedDecryptedBytes!).equals(Buffer.from(expectedBytes))).toBe(true);
  });

  // -------------------------------------------------------------------
  // ADVERSARIAL PORTAL RESPONSES — the key shapes a real portal might return
  // -------------------------------------------------------------------

  it("article: tolerates portal key with trailing newline (common ENV-var corruption)", async () => {
    // If the portal accidentally returns the key with a trailing newline,
    // base64urlDecode would treat the newline as padding and produce a
    // wrong-length buffer — we want this to FAIL LOUDLY at the fingerprint
    // check, NOT silently decrypt to garbage. The fingerprint mismatch
    // path then surfaces a Sentry event so we can diagnose.
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
      <PaymentWall
        mediaId="media-adv"
        products={products}
        storedProductIds={[]}
        mediaType="article"
      />
    );

    await waitFor(() => expect(screen.getAllByText(/Adversarial/)[0]).toBeInTheDocument());
    await user.click(screen.getAllByText(/Adversarial/)[0]);
    await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
    await user.click(screen.getByTestId("complete-btn"));

    // Must NOT silently render anything — and MUST capture a Sentry event
    // identifying the branch so we can diagnose in production.
    await waitFor(() => {
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        "PaymentWall.recordFailure",
        expect.objectContaining({
          tags: expect.objectContaining({
            context: "PaymentWall.recordFailure",
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
    // see PaymentWall.fingerprint failures. This is the cheapest, most
    // load-bearing assertion in the file.
    const k = genProductKey();
    const clientFp = await sha256HexOfString(k);

    // Server-side fingerprint computed via Node crypto (same algorithm
    // the Ruby portal uses: SHA-256 of the key string, hex-encoded).
    const serverFp = createHash("sha256").update(k).digest("hex");
    expect(clientFp).toBe(serverFp);
  });
});
