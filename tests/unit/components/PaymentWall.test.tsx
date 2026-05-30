// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../../helpers/fetch";
import type { MediaAccess } from "@/lib/use-media-access";

// --- Mocks ---

const mockSession = { data: null, status: "unauthenticated" as const };
vi.mock("next-auth/react", () => ({
  useSession: () => mockSession,
}));

const mockDecryptBlob = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
const mockVerifyKeyFingerprint = vi.fn().mockResolvedValue(true);
vi.mock("@/lib/client-crypto", () => ({
  decryptBlob: (...args: unknown[]) => mockDecryptBlob(...args),
  verifyKeyFingerprint: (...args: unknown[]) => mockVerifyKeyFingerprint(...args),
  // base64urlToBytes / decryptBytesWithKey are only used on the photo path,
  // which we exercise via mockDecryptBlob anyway in the unit-level tests.
  base64urlToBytes: (s: string) => new TextEncoder().encode(s),
  decryptBytesWithKey: async (bytes: Uint8Array) => bytes,
}));

const mockCaptureException = vi.fn();
const mockCaptureMessage = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

let mockLocale: "en" | "es" = "en";
vi.mock("@/i18n/useLocale", async () => {
  const { t: realT } = await import("@/i18n");
  return {
    useLocale: () => {
      const boundT = (key: string, params?: Record<string, string | number>) =>
        realT(mockLocale, key, params);
      return { t: boundT, locale: mockLocale };
    },
  };
});

vi.mock("@/components/ui/Button", () => ({
  default: ({ children, onClick, loading, className }: {
    children: React.ReactNode;
    onClick?: () => void;
    loading?: boolean;
    className?: string;
  }) => (
    <button onClick={onClick} disabled={loading} className={className} data-testid="unlock-btn">
      {children}
    </button>
  ),
}));

vi.mock("@/components/CheckoutOverlay", () => ({
  default: ({ checkoutToken, onComplete, onClose, merchantLogo, merchantName, priceCents, priceCurrency }: {
    checkoutToken: string;
    onComplete: (data: {
      key: string;
      macaroon: string;
      remaining_seconds?: number;
      order_number: string | null;
      order_id: string | null;
    }) => void;
    onClose: () => void;
    merchantLogo?: string;
    merchantName?: string;
    priceCents?: number;
    priceCurrency?: string;
  }) => (
    <div data-testid="checkout-overlay">
      <span data-testid="checkout-token">{checkoutToken}</span>
      {merchantLogo && <span data-testid="merchant-logo">{merchantLogo}</span>}
      {merchantName && <span data-testid="merchant-name">{merchantName}</span>}
      {priceCents != null && <span data-testid="price-cents">{priceCents}</span>}
      {priceCurrency && <span data-testid="price-currency">{priceCurrency}</span>}
      <button data-testid="complete-btn" onClick={() => onComplete({ key: "test-key", macaroon: "test-macaroon", remaining_seconds: 604800, order_number: "ORD-TESTREF12345678", order_id: "uuid-abc-123" })}>Complete</button>
      <button data-testid="complete-empty-btn" onClick={() => onComplete({ key: "", macaroon: "", order_number: null, order_id: null })}>Complete Empty</button>
      <button data-testid="complete-no-key-btn" onClick={() => onComplete({ key: "", macaroon: "test-macaroon", remaining_seconds: 604800, order_number: "ORD-NOKEY12345678", order_id: "uuid-nokey" })}>Complete No Key</button>
      <button data-testid="close-btn" onClick={onClose}>Close</button>
    </div>
  ),
}));

vi.mock("@/components/ContentRenderer", () => ({
  default: ({ mediaType }: { decryptedBytes: Uint8Array; mediaType: string }) => (
    <div data-testid="content-renderer">{mediaType}</div>
  ),
}));

vi.mock("@/components/ExchangeModal", () => ({
  default: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div data-testid="exchange-modal">
        <button data-testid="close-exchange" onClick={onClose}>Close Exchange</button>
      </div>
    ) : null,
}));

import PaymentWall from "@/components/PaymentWall";

const defaultProducts = [
  {
    productId: "prod-1",
    encryptedBlob: "encrypted-blob-1",
    keyFingerprint: "fp-1",
    name: "HD Video",
    priceCents: 500,
    currency: "USD",
    accessDurationSeconds: 3600,
    status: "active",
  },
];

// Common access state fixtures. PaymentWall reads access state as a prop;
// each test picks the fixture that matches the scenario it's exercising.
const NO_ACCESS: MediaAccess = { status: "inactive", reason: "no_cookie" };
const LOADING_ACCESS: MediaAccess = { status: "loading" };
const TRANSIENT_ACCESS: MediaAccess = { status: "inactive", reason: "transient" };
const ACTIVE_ACCESS: MediaAccess = {
  status: "active",
  productId: "prod-1",
  key: "active-key",
  remainingSeconds: 604800,
  encryptedBlob: "encrypted-blob-1",
};

const defaultProps = {
  mediaId: "media-123",
  products: defaultProducts,
  access: NO_ACCESS,
  onAccessClaim: () => {},
  thumbnailUrl: "https://example.com/thumb.jpg",
  mediaType: "video",
};

/**
 * Stateful wrapper that mirrors the parent's `useMediaAccess` integration:
 * when PaymentWall calls `onAccessClaim`, we transition the access prop to
 * "active" with that payload. Use this for end-to-end checkout-completion
 * tests where the test cares about what renders AFTER the claim fires.
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

/**
 * Most tests share the same fetch surface: `/api/checkout` POST mints a
 * token, `/api/macaroons` POST stores the macaroon. This helper installs
 * that default so tests only have to express what's DIFFERENT.
 */
function setupFreshPaymentScenario(
  overrides?: (url: string, init?: RequestInit) => unknown
) {
  mockFetch((url, init) => {
    const ov = overrides?.(url, init);
    if (ov !== undefined) return ov;
    if (url === "/api/checkout" && init?.method === "POST") {
      return { ok: true, json: async () => ({ token: "tok" }) };
    }
    if (url === "/api/macaroons" && init?.method === "POST") {
      return { ok: true, json: async () => ({}) };
    }
    return undefined; // fall through to 404
  });
}

describe("PaymentWall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.data = null;
    mockSession.status = "unauthenticated" as const;
    mockDecryptBlob.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mockVerifyKeyFingerprint.mockResolvedValue(true);
    mockLocale = "en";

    // Default: all fetches fail. Tests that need success paths override via mockFetch.
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
  });

  // -------------------------------------------------------
  // Initial render — payment wall (locked state)
  // -------------------------------------------------------
  describe("locked state (payment wall)", () => {
    it("renders payment wall with thumbnail", async () => {
      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText("Unlock with Bitcoin")[0]).toBeInTheDocument();
      });
      const img = screen.getByAltText("Preview");
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute("src", "https://example.com/thumb.jpg");
    });

    it("renders payment wall without thumbnail", async () => {
      render(<PaymentWall {...defaultProps} thumbnailUrl="" />);
      await waitFor(() => {
        expect(screen.getAllByText("Unlock with Bitcoin")[0]).toBeInTheDocument();
      });
      expect(screen.queryByAltText("Preview")).not.toBeInTheDocument();
    });

    it("shows product button with name and price", async () => {
      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
        expect(screen.getAllByText(/\$5/)[0]).toBeInTheDocument();
      });
    });

    it("shows 'Unlock content' when no name/price", async () => {
      const products = [{ productId: "prod-1", encryptedBlob: "blob" }];
      render(<PaymentWall {...defaultProps} products={products} />);
      await waitFor(() => {
        expect(screen.getAllByText("Unlock content")[0]).toBeInTheDocument();
      });
    });

    it("shows access duration for timed products", async () => {
      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText("1 hr access")[0]).toBeInTheDocument();
      });
    });

    it("formats duration as minutes", async () => {
      const products = [{ ...defaultProducts[0], accessDurationSeconds: 300 }];
      render(<PaymentWall {...defaultProps} products={products} />);
      await waitFor(() => {
        expect(screen.getAllByText("5 min access")[0]).toBeInTheDocument();
      });
    });

    it("formats duration as days", async () => {
      const products = [{ ...defaultProducts[0], accessDurationSeconds: 172800 }];
      render(<PaymentWall {...defaultProps} products={products} />);
      await waitFor(() => {
        expect(screen.getAllByText("2 days access")[0]).toBeInTheDocument();
      });
    });

    it("formats duration as singular day", async () => {
      const products = [{ ...defaultProducts[0], accessDurationSeconds: 86400 }];
      render(<PaymentWall {...defaultProps} products={products} />);
      await waitFor(() => {
        expect(screen.getAllByText("1 day access")[0]).toBeInTheDocument();
      });
    });

    it("shows Lifetime access for 0 seconds duration", async () => {
      const products = [{ ...defaultProducts[0], accessDurationSeconds: 0 }];
      render(<PaymentWall {...defaultProps} products={products} />);
      await waitFor(() => {
        expect(screen.getAllByText("Lifetime access")[0]).toBeInTheDocument();
      });
    });

    it("shows Need Bitcoin? button", async () => {
      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText("Need Bitcoin?")[0]).toBeInTheDocument();
      });
    });

    it("opens exchange modal when Need Bitcoin? is clicked", async () => {
      const user = userEvent.setup();
      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText("Need Bitcoin?")[0]).toBeInTheDocument();
      });
      await user.click(screen.getAllByText("Need Bitcoin?")[0]);
      expect(screen.getByTestId("exchange-modal")).toBeInTheDocument();
    });

    it("closes exchange modal", async () => {
      const user = userEvent.setup();
      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText("Need Bitcoin?")[0]).toBeInTheDocument();
      });
      await user.click(screen.getAllByText("Need Bitcoin?")[0]);
      await user.click(screen.getByTestId("close-exchange"));
      expect(screen.queryByTestId("exchange-modal")).not.toBeInTheDocument();
    });

    it("renders multiple products", async () => {
      const products = [
        defaultProducts[0],
        { ...defaultProducts[0], productId: "prod-2", name: "4K Video", priceCents: 1000 },
      ];
      render(<PaymentWall {...defaultProps} products={products} />);
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
        expect(screen.getAllByText(/4K Video/)[0]).toBeInTheDocument();
      });
    });

    it("formats price with cents when not even dollar", async () => {
      const products = [{ ...defaultProducts[0], priceCents: 550 }];
      render(<PaymentWall {...defaultProps} products={products} />);
      await waitFor(() => {
        expect(screen.getAllByText(/\$5\.50/)[0]).toBeInTheDocument();
      });
    });

  });

  // -------------------------------------------------------
  // Part A — access-first checking gate
  // -------------------------------------------------------
  // While the parent hook is still resolving access (and during the brief
  // active-but-still-decrypting window) we must show a neutral placeholder,
  // never the buy buttons. A returning paid viewer used to see the paywall
  // flash before content appeared; the gate eliminates that.
  describe("access-first checking gate", () => {
    it("shows the checking placeholder (not pay buttons) while access is loading", async () => {
      render(<PaymentWall {...defaultProps} access={LOADING_ACCESS} />);
      await waitFor(() => {
        expect(screen.getByTestId("checking-access")).toBeInTheDocument();
      });
      // No buy buttons while loading...
      expect(screen.queryByText("Unlock with Bitcoin")).not.toBeInTheDocument();
      // ...and loading is not a confirmed hiccup, so no verify-failure card.
      expect(screen.queryByText("Couldn't verify your access")).not.toBeInTheDocument();
    });

    it("shows the checking placeholder while access is active but still decrypting", async () => {
      // This window also sits past the decryptedBytes early return. Honoring
      // the access-first contract means a spinner here, not a button flash.
      mockDecryptBlob.mockImplementation(() => new Promise<Uint8Array>(() => {}));
      render(<PaymentWall {...defaultProps} access={ACTIVE_ACCESS} />);
      await waitFor(() => {
        expect(screen.getByTestId("checking-access")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("content-renderer")).not.toBeInTheDocument();
      expect(screen.queryByText("Unlock with Bitcoin")).not.toBeInTheDocument();
    });

    it("shows pay buttons (not the placeholder) once access resolves to inactive", async () => {
      render(<PaymentWall {...defaultProps} access={NO_ACCESS} />);
      await waitFor(() => {
        expect(screen.getAllByText("Unlock with Bitcoin")[0]).toBeInTheDocument();
      });
      expect(screen.queryByTestId("checking-access")).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------
  // Part B — content-integrity error reporting
  // -------------------------------------------------------
  // On a confirmed-integrity decrypt failure the client best-effort POSTs
  // /api/media/[id]/report-error so the server can re-decrypt, confirm, and
  // flag the media. Transient (availability) failures must NOT report — a
  // network blip should never take good content offline.
  describe("integrity error reporting", () => {
    function reportErrorCalls() {
      return (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === "/api/media/media-123/report-error"
      );
    }

    it("reports an integrity decrypt failure on active access (OperationError → integrity_auth_failed)", async () => {
      // Valid macaroon + key, but AES-GCM rejects with OperationError — the
      // ciphertext or key is wrong (integrity). No payment happened this
      // session (mount-time active access), so no orderId is sent.
      mockDecryptBlob.mockRejectedValue(
        new DOMException("OperationError: auth tag mismatch", "OperationError")
      );

      render(<PaymentWall {...defaultProps} access={ACTIVE_ACCESS} />);

      await waitFor(() => expect(reportErrorCalls()).toHaveLength(1));
      const init = reportErrorCalls()[0][1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        reason: "integrity_auth_failed",
        productId: "prod-1",
      });
    });

    it("does NOT report a transient envelope-fetch failure (availability, not integrity)", async () => {
      // photo media unwraps the DEK fine, then the envelope fetch 500s. That's
      // availability — classifyDecryptFailure returns null, so we must not flag
      // good content offline over a network blip.
      mockFetch((url) => {
        if (url.startsWith("/api/envelopes/")) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return undefined; // everything else → 404 default
      });

      render(
        <PaymentWall
          {...defaultProps}
          access={ACTIVE_ACCESS}
          mediaType="photo"
          envelopeId="env-1"
        />
      );

      // Wait for the failure card so the decrypt attempt has fully resolved.
      await waitFor(() => {
        expect(screen.getByText("Payment received")).toBeInTheDocument();
      });
      expect(reportErrorCalls()).toHaveLength(0);
    });

    it("reports a post-payment key fingerprint mismatch (key_fingerprint_mismatch + order id)", async () => {
      const user = userEvent.setup();
      setupFreshPaymentScenario();
      mockVerifyKeyFingerprint.mockResolvedValue(false);

      render(<StatefulPaymentWall {...defaultProps} />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-btn"));

      await waitFor(() => expect(reportErrorCalls()).toHaveLength(1));
      const init = reportErrorCalls()[0][1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({
        reason: "key_fingerprint_mismatch",
        productId: "prod-1",
        orderId: "uuid-abc-123",
      });
    });
  });

  // -------------------------------------------------------
  // Active access — content rendering
  // -------------------------------------------------------
  describe("active access (content rendering)", () => {
    it("renders ContentRenderer when access becomes active", async () => {
      render(<PaymentWall {...defaultProps} access={ACTIVE_ACCESS} />);
      await waitFor(() => {
        expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
      });
    });

    it("decrypts using the key from the access prop", async () => {
      render(<PaymentWall {...defaultProps} access={ACTIVE_ACCESS} />);
      await waitFor(() => {
        expect(mockDecryptBlob).toHaveBeenCalledWith(
          ACTIVE_ACCESS.encryptedBlob,
          ACTIVE_ACCESS.key,
          ACTIVE_ACCESS.productId
        );
      });
    });

    it("shows artwork for audio mediaType", async () => {
      render(<PaymentWall {...defaultProps} access={ACTIVE_ACCESS} mediaType="audio" />);
      await waitFor(() => {
        expect(screen.getByAltText("Artwork")).toBeInTheDocument();
      });
    });

    it("shows artwork for podcast mediaType", async () => {
      render(<PaymentWall {...defaultProps} access={ACTIVE_ACCESS} mediaType="podcast" />);
      await waitFor(() => {
        expect(screen.getByAltText("Artwork")).toBeInTheDocument();
      });
    });

    it("does not show artwork for video mediaType", async () => {
      render(<PaymentWall {...defaultProps} access={ACTIVE_ACCESS} mediaType="video" />);
      await waitFor(() => {
        expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
      });
      expect(screen.queryByAltText("Artwork")).not.toBeInTheDocument();
    });

    it("falls back to the paywall when access drops back to inactive", async () => {
      // Mid-session: parent's hook flips access from active to inactive (the
      // macaroon naturally expired, the cookie was cleared by another tab,
      // whatever). PaymentWall must clear decryptedBytes and surface pay
      // buttons immediately — the founder's "image disappears" regression
      // came from leaving stale bytes on screen after this transition.
      const { rerender } = render(
        <PaymentWall {...defaultProps} access={ACTIVE_ACCESS} />
      );
      await waitFor(() => {
        expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
      });

      rerender(<PaymentWall {...defaultProps} access={NO_ACCESS} />);
      await waitFor(() => {
        expect(screen.queryByTestId("content-renderer")).not.toBeInTheDocument();
        expect(screen.getAllByText("Unlock with Bitcoin")[0]).toBeInTheDocument();
      });
    });

    it("shows UnlockFailureCard when decryption blows up on active access", async () => {
      // Active access + decryption error = customer-visible "I paid but it
      // won't load" moment. Surface the failure card and log to Sentry
      // with context PaymentWall.decryptOnAccess.
      mockDecryptBlob.mockRejectedValue(new Error("AES-GCM auth tag mismatch"));

      render(<PaymentWall {...defaultProps} access={ACTIVE_ACCESS} />);
      await waitFor(() => {
        expect(screen.getByText("Payment received")).toBeInTheDocument();
      });
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ context: "PaymentWall.decryptOnAccess" }),
          extra: expect.objectContaining({
            mediaId: "media-123",
            activeProductId: "prod-1",
            errorMessage: "AES-GCM auth tag mismatch",
          }),
        })
      );
    });

    it("the failure card on mount-time decryption error shows 'Reference unavailable' because no order ids are known yet", async () => {
      // Mount-time decryption failure happens BEFORE any payment in this
      // session — the user landed on the page with a pre-existing macaroon
      // that the parent's hook validated. The UnlockFailureCard has no
      // order ids to show in that case.
      mockDecryptBlob.mockRejectedValue(new Error("AAD verify failed"));

      render(<PaymentWall {...defaultProps} access={ACTIVE_ACCESS} />);
      await waitFor(() => {
        expect(screen.getByText("Reference unavailable")).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------
  // Verify failure card (parent hook reported a transient error)
  // -------------------------------------------------------
  describe("verify failure card", () => {
    it("shows VerifyFailureCard when access.reason is 'transient'", async () => {
      render(
        <PaymentWall {...defaultProps} access={TRANSIENT_ACCESS} merchantName="Acme Co" />
      );
      await waitFor(() => {
        expect(screen.getByText("Couldn't verify your access")).toBeInTheDocument();
      });
      // Pay buttons hidden — we don't ask the user to pay again if we
      // can't verify; we ask them to reload.
      expect(screen.queryByText(/HD Video/)).not.toBeInTheDocument();
      expect(screen.getByText("Contact Acme Co for support.")).toBeInTheDocument();
      expect(screen.getByText("Reload page")).toBeInTheDocument();
    });

    it("does NOT show VerifyFailureCard for the 'no_cookie' reason (fresh visitor)", async () => {
      render(<PaymentWall {...defaultProps} access={NO_ACCESS} />);
      await waitFor(() => {
        expect(screen.getAllByText("Unlock with Bitcoin")[0]).toBeInTheDocument();
      });
      expect(screen.queryByText("Couldn't verify your access")).not.toBeInTheDocument();
    });

    it("renders the ExpiredAccessBanner above the unlock buttons when access.expiredAt is set", async () => {
      // The "returning visitor whose subscription lapsed" case — the
      // useMediaAccess hook picked up `expired_at` from the unlock 401
      // and surfaces it here so the paywall isn't silent about WHY the
      // user is being asked to pay again.
      const expiredAt = new Date("2026-05-15T21:20:45.228Z");
      render(
        <PaymentWall
          {...defaultProps}
          access={{
            status: "inactive",
            reason: "portal_rejected",
            expiredAt,
            expiredProductId: "prod-1",
          }}
        />
      );
      await waitFor(() => {
        expect(screen.getByTestId("expired-access-banner")).toBeInTheDocument();
      });
      expect(screen.getByText("Your access expired")).toBeInTheDocument();
      // Pay buttons still render — the user CAN renew.
      expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
    });

    it("does NOT render the ExpiredAccessBanner for a fresh visitor (no expiredAt)", async () => {
      render(<PaymentWall {...defaultProps} access={NO_ACCESS} />);
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });
      expect(screen.queryByTestId("expired-access-banner")).not.toBeInTheDocument();
    });

    it("does NOT show VerifyFailureCard for the 'portal_rejected' reason (cookie present but invalid)", async () => {
      // portal_rejected means the macaroon failed verification — that's a
      // real expiry, not a transient hiccup. We show the paywall.
      render(
        <PaymentWall
          {...defaultProps}
          access={{ status: "inactive", reason: "portal_rejected" }}
        />
      );
      await waitFor(() => {
        expect(screen.getAllByText("Unlock with Bitcoin")[0]).toBeInTheDocument();
      });
      expect(screen.queryByText("Couldn't verify your access")).not.toBeInTheDocument();
    });

    it("reload button on VerifyFailureCard calls window.location.reload", async () => {
      const reloadSpy = vi.fn();
      Object.defineProperty(window, "location", {
        value: { ...window.location, reload: reloadSpy },
        writable: true,
      });

      render(<PaymentWall {...defaultProps} access={TRANSIENT_ACCESS} />);
      await waitFor(() => {
        expect(screen.getByText("Couldn't verify your access")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.click(screen.getByText("Reload page"));
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------
  // Checkout flow (clicking unlock → checkout overlay)
  // -------------------------------------------------------
  describe("checkout flow", () => {
    it("creates checkout session and shows overlay", async () => {
      const user = userEvent.setup();

      mockFetch((url, opts) => {
        if (url === "/api/checkout" && opts?.method === "POST") {
          return { ok: true, json: async () => ({ token: "checkout-token-123" }) };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });

      await user.click(screen.getAllByText(/HD Video/)[0]);

      await waitFor(() => {
        expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument();
        expect(screen.getByTestId("checkout-token")).toHaveTextContent("checkout-token-123");
      });
    });

    it("shows error when checkout fails", async () => {
      const user = userEvent.setup();

      mockFetch((url, opts) => {
        if (url === "/api/checkout" && opts?.method === "POST") {
          return { ok: false, json: async () => ({ error: "Checkout failed" }) };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });

      await user.click(screen.getAllByText(/HD Video/)[0]);

      await waitFor(() => {
        expect(screen.getByText("Checkout failed")).toBeInTheDocument();
      });
    });

    it("shows generic error when checkout throws", async () => {
      const user = userEvent.setup();

      mockFetch((url, opts) => {
        if (url === "/api/checkout" && opts?.method === "POST") {
          throw new Error("Network error");
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });

      await user.click(screen.getAllByText(/HD Video/)[0]);

      await waitFor(() => {
        expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      });
    });

    it("shows default error message when server returns no error field", async () => {
      const user = userEvent.setup();

      mockFetch((url, opts) => {
        if (url === "/api/checkout" && opts?.method === "POST") {
          return { ok: false, json: async () => ({}) };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });

      await user.click(screen.getAllByText(/HD Video/)[0]);

      await waitFor(() => {
        expect(screen.getByText("Failed to create checkout session")).toBeInTheDocument();
      });
    });

    it("closes checkout overlay", async () => {
      const user = userEvent.setup();

      mockFetch((url, opts) => {
        if (url === "/api/checkout" && opts?.method === "POST") {
          return { ok: true, json: async () => ({ token: "tok" }) };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });

      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => {
        expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("close-btn"));
      expect(screen.queryByTestId("checkout-overlay")).not.toBeInTheDocument();
    });

    it("passes merchant info to checkout overlay", async () => {
      const user = userEvent.setup();

      mockFetch((url, opts) => {
        if (url === "/api/checkout" && opts?.method === "POST") {
          return { ok: true, json: async () => ({ token: "tok" }) };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(
        <PaymentWall
          {...defaultProps}
          merchantLogo="https://example.com/logo.png"
          merchantName="Test Merchant"
        />
      );
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });

      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => {
        expect(screen.getByTestId("merchant-logo")).toHaveTextContent("https://example.com/logo.png");
        expect(screen.getByTestId("merchant-name")).toHaveTextContent("Test Merchant");
        expect(screen.getByTestId("price-cents")).toHaveTextContent("500");
        expect(screen.getByTestId("price-currency")).toHaveTextContent("USD");
      });
    });
  });

  // -------------------------------------------------------
  // Checkout completion (post-payment)
  // -------------------------------------------------------
  describe("checkout completion", () => {
    it("calls onAccessClaim with the full payload after successful checkout", async () => {
      const user = userEvent.setup();
      const onAccessClaim = vi.fn();
      setupFreshPaymentScenario();

      render(
        <PaymentWall {...defaultProps} access={NO_ACCESS} onAccessClaim={onAccessClaim} />
      );
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-btn"));

      await waitFor(() => {
        expect(onAccessClaim).toHaveBeenCalledWith({
          productId: "prod-1",
          key: "test-key",
          remainingSeconds: 604800,
          encryptedBlob: "encrypted-blob-1",
        });
      });
    });

    it("fires onAccessClaim IMMEDIATELY (no roundtrip / delay)", async () => {
      // Regression guard for the original "access pill appears 30s late"
      // bug: we used to wait for HeartbeatManager to fire before the timer
      // showed. With onAccessClaim now the synchronous handoff, the parent
      // hook flips to active the moment the portal returns success.
      const user = userEvent.setup();
      const onAccessClaim = vi.fn();
      setupFreshPaymentScenario();

      render(
        <PaymentWall {...defaultProps} access={NO_ACCESS} onAccessClaim={onAccessClaim} />
      );
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-btn"));

      await waitFor(() => {
        expect(onAccessClaim).toHaveBeenCalledTimes(1);
      });
      // remainingSeconds matches the mocked CheckoutOverlay payload (7 days).
      expect(onAccessClaim).toHaveBeenCalledWith(
        expect.objectContaining({ remainingSeconds: 604800 })
      );
    });

    it("decrypts content after the parent's hook transitions to active", async () => {
      // End-to-end: complete payment → onAccessClaim → parent flips access →
      // decryption fires → ContentRenderer renders. The StatefulPaymentWall
      // wrapper mirrors the real parent's behavior.
      const user = userEvent.setup();
      setupFreshPaymentScenario();

      render(<StatefulPaymentWall {...defaultProps} initialAccess={NO_ACCESS} />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-btn"));

      await waitFor(() => expect(screen.getByTestId("content-renderer")).toBeInTheDocument());
    });

    it("stores macaroon after checkout completion", async () => {
      const user = userEvent.setup();
      setupFreshPaymentScenario();

      render(<StatefulPaymentWall {...defaultProps} />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-btn"));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/macaroons", expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("test-macaroon"),
        }));
      });
    });

    it("shows the unlock-failed card when post-payment key fingerprint verification fails", async () => {
      const user = userEvent.setup();
      setupFreshPaymentScenario();
      mockVerifyKeyFingerprint.mockResolvedValue(false);

      render(<StatefulPaymentWall {...defaultProps} />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-btn"));

      await waitFor(() => {
        expect(screen.getByText("Payment received")).toBeInTheDocument();
      });
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        "Key fingerprint mismatch after payment",
        expect.objectContaining({
          tags: expect.objectContaining({ context: "PaymentWall.fingerprint" }),
        })
      );
    });

    it("does not store empty macaroon and logs to Sentry", async () => {
      const user = userEvent.setup();

      mockFetch((url, opts) => {
        if (url === "/api/checkout" && opts?.method === "POST") {
          return { ok: true, json: async () => ({ token: "tok" }) };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<StatefulPaymentWall {...defaultProps} />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-empty-btn"));

      await waitFor(() => {
        const macaroonPosts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
          (c: unknown[]) => c[0] === "/api/macaroons" && (c[1] as RequestInit | undefined)?.method === "POST"
        );
        expect(macaroonPosts).toHaveLength(0);
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          "Checkout completed with empty macaroon",
          expect.objectContaining({ level: "warning" })
        );
      });
    });

    it("shows the unlock-failed card when the portal returns no key", async () => {
      const user = userEvent.setup();
      setupFreshPaymentScenario();

      render(<StatefulPaymentWall {...defaultProps} />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-no-key-btn"));

      await waitFor(() => {
        expect(screen.getByText("Payment received")).toBeInTheDocument();
      });
    });

    it("shows the unlock-failed card when decryption fails after checkout (and surfaces order ids on the card)", async () => {
      // End-to-end: payment completes → access claim fires → decryption
      // effect runs → decryption fails → UnlockFailureCard shown. The card
      // shows the order ids that came in with the payment payload (NOT
      // null — that was the regression I'm guarding against here).
      const user = userEvent.setup();
      setupFreshPaymentScenario();
      mockDecryptBlob.mockRejectedValue(new Error("Decryption error"));

      render(<StatefulPaymentWall {...defaultProps} />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-btn"));

      await waitFor(() => {
        expect(screen.getByText("Payment received")).toBeInTheDocument();
      });
      expect(screen.getByText("ORD-TESTREF12345678")).toBeInTheDocument();
      expect(screen.getByText("uuid-abc-123")).toBeInTheDocument();
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ context: "PaymentWall.decryptOnAccess" }),
        })
      );
    });
  });

  // -------------------------------------------------------
  // Sentry instrumentation
  // -------------------------------------------------------
  // The recordFailure Sentry contract is the diagnostic backbone we built
  // up to triage post-payment failures from the demo. Each customer-visible
  // failure MUST produce a single tagged event so a Sentry filter on
  // `context: PaymentWall.recordFailure` reveals every one.
  describe("recordFailure Sentry contract", () => {
    it("fires recordFailure with reason=fingerprintMismatch when the post-payment key fingerprint is wrong", async () => {
      const user = userEvent.setup();
      setupFreshPaymentScenario();
      mockVerifyKeyFingerprint.mockResolvedValue(false);

      render(<StatefulPaymentWall {...defaultProps} mediaType="article" />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-btn"));

      await waitFor(() => {
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          "PaymentWall.recordFailure",
          expect.objectContaining({
            level: "error",
            tags: expect.objectContaining({
              context: "PaymentWall.recordFailure",
              reason: "fingerprintMismatch",
              mediaType: "article",
            }),
            extra: expect.objectContaining({
              mediaId: "media-123",
              activeProductId: "prod-1",
              mediaType: "article",
              orderId: "uuid-abc-123",
              orderNumber: "ORD-TESTREF12345678",
              hadKey: true,
              hadMacaroon: true,
            }),
          })
        );
      });
    });

    it("fires recordFailure with reason=noKeyFromPortal when the portal returns an empty key", async () => {
      const user = userEvent.setup();
      setupFreshPaymentScenario();

      render(<StatefulPaymentWall {...defaultProps} mediaType="article" />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-no-key-btn"));

      await waitFor(() => {
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          "PaymentWall.recordFailure",
          expect.objectContaining({
            tags: expect.objectContaining({
              reason: "noKeyFromPortal",
              mediaType: "article",
            }),
            extra: expect.objectContaining({ hadKey: false, hadMacaroon: true }),
          })
        );
      });
    });

    it("captures decryption-on-active-access exceptions with context PaymentWall.decryptOnAccess", async () => {
      // The post-claim decryption path used to report under
      // PaymentWall.decrypt; it's now PaymentWall.decryptOnAccess because the
      // effect (not handleCheckoutComplete) owns the call. Pinning the tag
      // here protects the Sentry filter that operations relies on.
      const user = userEvent.setup();
      setupFreshPaymentScenario();
      mockDecryptBlob.mockRejectedValue(new Error("AES-GCM auth tag mismatch"));

      render(<StatefulPaymentWall {...defaultProps} mediaType="photo" />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-btn"));

      await waitFor(() => {
        expect(mockCaptureException).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({
            tags: expect.objectContaining({
              context: "PaymentWall.decryptOnAccess",
              mediaType: "photo",
            }),
            extra: expect.objectContaining({
              mediaId: "media-123",
              activeProductId: "prod-1",
              mediaType: "photo",
              errorMessage: "AES-GCM auth tag mismatch",
            }),
          })
        );
      });
    });

    it("reports non-2xx macaroon storage as a PaymentWall.macaroonStore Sentry event", async () => {
      const user = userEvent.setup();
      mockFetch((url, init) => {
        if (url === "/api/checkout" && init?.method === "POST") {
          return { ok: true, json: async () => ({ token: "tok" }) };
        }
        if (url === "/api/macaroons" && init?.method === "POST") {
          return { ok: false, status: 503, json: async () => ({ error: "down" }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });

      // Use url-backed media (video) so this test focuses on the macaroon
      // side-channel without needing an envelope-fetch mock for the
      // decrypt step.
      render(<StatefulPaymentWall {...defaultProps} mediaType="video" />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-btn"));

      await waitFor(() => {
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          "Failed to store macaroon (non-2xx)",
          expect.objectContaining({
            level: "error",
            tags: expect.objectContaining({ context: "PaymentWall.macaroonStore" }),
            extra: expect.objectContaining({
              mediaId: "media-123",
              activeProductId: "prod-1",
              mediaType: "video",
              status: 503,
            }),
          })
        );
      });
      // Direct decryption still succeeded (the macaroon store is a side
      // channel for refresh-persistence; the in-memory access claim still
      // happens), so the user sees content, not the failure card.
      expect(await screen.findByTestId("content-renderer")).toBeInTheDocument();
    });

    it("captures the exception when the macaroon storage fetch throws", async () => {
      const user = userEvent.setup();
      mockFetch((url, init) => {
        if (url === "/api/checkout" && init?.method === "POST") {
          return { ok: true, json: async () => ({ token: "tok" }) };
        }
        if (url === "/api/macaroons" && init?.method === "POST") {
          throw new Error("network down");
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });

      render(<StatefulPaymentWall {...defaultProps} mediaType="photo" />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-btn"));

      await waitFor(() => {
        expect(mockCaptureException).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({
            tags: expect.objectContaining({ context: "PaymentWall.macaroonStore" }),
            extra: expect.objectContaining({
              mediaId: "media-123",
              activeProductId: "prod-1",
              mediaType: "photo",
            }),
          })
        );
      });
    });
  });

  // -------------------------------------------------------
  // Unlock failure card (post-payment customer-visible failure)
  // -------------------------------------------------------
  describe("unlock failure card", () => {
    async function payAndFail(merchantName?: string) {
      const user = userEvent.setup();
      setupFreshPaymentScenario();
      mockDecryptBlob.mockRejectedValue(new Error("AAD verify failed"));

      render(
        <StatefulPaymentWall
          {...defaultProps}
          {...(merchantName ? { merchantName } : {})}
        />
      );
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => {
        expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("complete-btn"));
      await waitFor(() => {
        expect(screen.getByText("Payment received")).toBeInTheDocument();
      });
      return user;
    }

    it("hides the pay buttons and unmounts the checkout overlay on failure", async () => {
      await payAndFail("Acme Co");
      expect(screen.queryByText("Unlock with Bitcoin")).not.toBeInTheDocument();
      expect(screen.queryByTestId("checkout-overlay")).not.toBeInTheDocument();
      expect(screen.queryByText("Need Bitcoin?")).not.toBeInTheDocument();
    });

    it("renders the order_number reference and contact line", async () => {
      await payAndFail("Acme Co");
      expect(screen.getByText("ORD-TESTREF12345678")).toBeInTheDocument();
      expect(screen.getByText("uuid-abc-123")).toBeInTheDocument();
      expect(screen.getByText("Contact Acme Co for support.")).toBeInTheDocument();
      expect(screen.getByText("Failed at")).toBeInTheDocument();
    });

    it("reload button calls window.location.reload", async () => {
      const reloadSpy = vi.fn();
      Object.defineProperty(window, "location", {
        value: { ...window.location, reload: reloadSpy },
        writable: true,
      });
      const user = await payAndFail();
      await user.click(screen.getByText("Reload page"));
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    it("copy reference button writes to the clipboard", async () => {
      const user = await payAndFail();
      const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
      await user.click(screen.getByText("Copy reference"));
      expect(writeTextSpy).toHaveBeenCalledWith("ORD-TESTREF12345678 / uuid-abc-123");
      await waitFor(() => {
        expect(screen.getByText("Copied")).toBeInTheDocument();
      });
    });

    it("falls back to 'Reference unavailable' when both order fields are null", async () => {
      const user = userEvent.setup();
      mockDecryptBlob.mockRejectedValue(new Error("decrypt"));
      mockFetch((url, init) => {
        if (url === "/api/checkout" && init?.method === "POST") {
          return { ok: true, json: async () => ({ token: "tok" }) };
        }
        return { ok: false, json: async () => ({}) };
      });
      render(<StatefulPaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => {
        expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("complete-empty-btn"));
      await waitFor(() => {
        expect(screen.getByText("Reference unavailable")).toBeInTheDocument();
      });
      expect(screen.queryByText("Copy reference")).not.toBeInTheDocument();
    });

    it("renders the generic contact line when merchantName is not provided", async () => {
      await payAndFail();
      expect(screen.getByText("Contact the merchant for support.")).toBeInTheDocument();
    });

    it("falls back to execCommand and shows error when clipboard API is unavailable", async () => {
      const user = await payAndFail();

      // Remove clipboard from navigator to simulate non-secure context
      const originalClipboard = navigator.clipboard;
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      // Force execCommand to fail too — verify error feedback
      const originalExecCommand = document.execCommand;
      document.execCommand = vi.fn().mockReturnValue(false);

      await user.click(screen.getByText("Copy reference"));
      await waitFor(() => {
        expect(screen.getByText(/Couldn't copy/)).toBeInTheDocument();
      });

      Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
      document.execCommand = originalExecCommand;
    });

    it("renders the unlock-failed card in Spanish locale", async () => {
      mockLocale = "es";
      const user = userEvent.setup();
      setupFreshPaymentScenario();
      mockDecryptBlob.mockRejectedValue(new Error("AAD verify failed"));
      render(<StatefulPaymentWall {...defaultProps} merchantName="Acme Co" />);
      await waitFor(() => {
        expect(screen.getAllByText("Desbloquear con Bitcoin")[0]).toBeInTheDocument();
      });
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => {
        expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("complete-btn"));
      await waitFor(() => {
        expect(screen.getByText("Pago recibido")).toBeInTheDocument();
      });
      expect(screen.getByText("Falló a las")).toBeInTheDocument();
      expect(screen.getByText("Referencia del pedido")).toBeInTheDocument();
      expect(screen.getByText("Recargar página")).toBeInTheDocument();
      expect(screen.getByText("Copiar referencia")).toBeInTheDocument();
      expect(screen.getByText("Contacta a Acme Co para asistencia.")).toBeInTheDocument();
    });
  });
});
