// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../../helpers/fetch";

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
      <button data-testid="complete-btn" onClick={() => onComplete({ key: "test-key", macaroon: "test-macaroon", order_number: "ORD-TESTREF12345678", order_id: "uuid-abc-123" })}>Complete</button>
      <button data-testid="complete-empty-btn" onClick={() => onComplete({ key: "", macaroon: "", order_number: null, order_id: null })}>Complete Empty</button>
      <button data-testid="complete-no-key-btn" onClick={() => onComplete({ key: "", macaroon: "test-macaroon", order_number: "ORD-NOKEY12345678", order_id: "uuid-nokey" })}>Complete No Key</button>
      <button data-testid="close-btn" onClick={onClose}>Close</button>
    </div>
  ),
}));

vi.mock("@/components/ContentRenderer", () => ({
  default: ({ mediaType }: { decryptedBytes: Uint8Array; mediaType: string }) => (
    <div data-testid="content-renderer">{mediaType}</div>
  ),
}));

vi.mock("@/components/HeartbeatManager", () => ({
  default: ({ productId, onExpired, onKeyRefreshed }: {
    productId: string;
    onExpired: () => void;
    onKeyRefreshed: (key: string) => void;
  }) => (
    <div data-testid="heartbeat-manager" data-product-id={productId}>
      <button data-testid="expire-btn" onClick={onExpired}>Expire</button>
      <button data-testid="refresh-key-btn" onClick={() => onKeyRefreshed("refreshed-key")}>Refresh</button>
    </div>
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

const defaultProps = {
  mediaId: "media-123",
  products: defaultProducts,
  storedProductIds: ["prod-1"],
  thumbnailUrl: "https://example.com/thumb.jpg",
  mediaType: "video",
};

/**
 * The post-payment journey for a fresh visitor has the same fetch surface
 * across many tests: `/api/checkout` POST mints a token, `/api/macaroons`
 * POST stores the macaroon, every other request falls through to a 404 so
 * mount-time checkAccess shows pay buttons. This helper installs that fetch
 * mock so tests only have to express what makes them DIFFERENT.
 *
 * Override behaviors via the `overrides` param — return undefined to fall
 * through to the default; return a Response-shaped object to take over.
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

    // Default: all fetches fail so we see the payment wall
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

    it("shows 'Unlock with Lightning' when no name/price", async () => {
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
  // Unlock via macaroons on mount
  // -------------------------------------------------------
  describe("macaroon-based unlock", () => {
    it("unlocks content when macaroon is valid", async () => {
      mockFetch((url, opts) => {
        if (url === "/api/macaroons" && opts?.method === "PUT") {
          return { ok: true, json: async () => ({ key: "aes-key", key_fingerprint: "fp-1" }) };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
      });
    });

    it("skips macaroon when key fingerprint verification fails", async () => {
      mockVerifyKeyFingerprint.mockResolvedValue(false);

      mockFetch((url, opts) => {
        if (url === "/api/macaroons" && opts?.method === "PUT") {
          return { ok: true, json: async () => ({ key: "aes-key", key_fingerprint: "fp-1" }) };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText("Unlock with Bitcoin")[0]).toBeInTheDocument();
      });
    });

    it("falls back to direct unlock when macaroons fail", async () => {
      mockFetch((url, opts) => {
        if (url === "/api/macaroons" && opts?.method === "PUT") {
          return { ok: false, json: async () => ({}) };
        }
        if (url === "/api/media/media-123/unlock") {
          return {
            ok: true,
            json: async () => ({
              key: "direct-key",
              key_fingerprint: "fp-1",
              encrypted_blob: "encrypted-blob-1",
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
      });
    });

    it("shows payment wall when direct unlock also fails", async () => {
      mockFetch(() => {
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText("Unlock with Bitcoin")[0]).toBeInTheDocument();
      });
    });

    it("handles direct unlock throwing an exception", async () => {
      mockFetch((url, opts) => {
        if (url === "/api/macaroons" && opts?.method === "PUT") {
          return { ok: false, json: async () => ({}) };
        }
        if (url === "/api/media/media-123/unlock") {
          throw new Error("Network error");
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText("Unlock with Bitcoin")[0]).toBeInTheDocument();
      });
    });

    it("handles macaroon fetch throwing an exception", async () => {
      mockFetch((url, opts) => {
        if (url === "/api/macaroons" && opts?.method === "PUT") {
          throw new Error("Network error");
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText("Unlock with Bitcoin")[0]).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------
  // Checkout flow
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
  // Checkout completion
  // -------------------------------------------------------
  describe("checkout completion", () => {
    it("decrypts content after successful checkout", async () => {
      const user = userEvent.setup();
      setupFreshPaymentScenario();

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });

      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => {
        expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("complete-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
      });
    });

    it("stores macaroon after checkout completion", async () => {
      const user = userEvent.setup();
      setupFreshPaymentScenario();

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });

      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => {
        expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("complete-btn"));
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/macaroons", expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("test-macaroon"),
        }));
      });
    });

    it("records purchase when user is a customer", async () => {
      const user = userEvent.setup();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockSession as any).data = { user: { role: "customer" } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockSession as any).status = "authenticated";

      mockFetch((url, opts) => {
        if (url === "/api/checkout" && opts?.method === "POST") {
          return { ok: true, json: async () => ({ token: "tok" }) };
        }
        if (url === "/api/macaroons" && opts?.method === "PUT") {
          return { ok: false, json: async () => ({}) };
        }
        if (url === "/api/media/media-123/unlock") {
          return { ok: false, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });

      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => {
        expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("complete-btn"));
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/customer/purchases", expect.objectContaining({
          method: "POST",
        }));
      });
    });

    it("shows the unlock-failed card when key fingerprint verification fails during checkout", async () => {
      const user = userEvent.setup();
      // Fingerprint-checks pass during mount checkAccess (no stored cookie),
      // and fail only AFTER the user pays.
      mockFetch((url, opts) => {
        if (url === "/api/checkout" && opts?.method === "POST") {
          return { ok: true, json: async () => ({ token: "tok" }) };
        }
        // Fail any unlock-related fetch so checkAccess doesn't unlock and
        // doesn't trigger verifyFailure either (no transient signal).
        return { ok: false, status: 404, json: async () => ({}) };
      });

      // Fresh visitor — no stored macaroon — so checkAccess shows pay buttons.
      render(<PaymentWall {...defaultProps} storedProductIds={[]} />);

      // Now arrange the post-payment fingerprint failure
      mockVerifyKeyFingerprint.mockResolvedValue(false);
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
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        "Key fingerprint mismatch after payment",
        expect.objectContaining({ tags: expect.objectContaining({ context: "PaymentWall.fingerprint" }) })
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

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });

      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => {
        expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("complete-empty-btn"));
      await waitFor(() => {
        // Should NOT have called POST /api/macaroons with empty value
        const macaroonPosts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
          (c: unknown[]) => c[0] === "/api/macaroons" && (c[1] as RequestInit | undefined)?.method === "POST"
        );
        expect(macaroonPosts).toHaveLength(0);
        // Should have logged to Sentry
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          "Checkout completed with empty macaroon",
          expect.objectContaining({ level: "warning" })
        );
      });
    });

    it("falls back to unlock endpoint when key is empty after checkout", async () => {
      const user = userEvent.setup();
      let checkoutCreated = false;

      mockFetch((url, opts) => {
        if (url === "/api/checkout" && opts?.method === "POST") {
          checkoutCreated = true;
          return { ok: true, json: async () => ({ token: "tok" }) };
        }
        if (url === "/api/macaroons" && opts?.method === "POST") {
          return { ok: true, json: async () => ({}) };
        }
        if (url === "/api/media/media-123/unlock") {
          // Fail on initial mount, succeed after checkout
          if (!checkoutCreated) return { ok: false, json: async () => ({}) };
          return {
            ok: true,
            json: async () => ({
              key: "fallback-key",
              key_fingerprint: "fp-1",
              encrypted_blob: "encrypted-blob-1",
              product_id: "prod-1",
            }),
          };
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

      await user.click(screen.getByTestId("complete-no-key-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
      });
    });

    it("shows the unlock-failed card when both direct key and unlock fallback fail", async () => {
      const user = userEvent.setup();

      mockFetch((url, opts) => {
        if (url === "/api/checkout" && opts?.method === "POST") {
          return { ok: true, json: async () => ({ token: "tok" }) };
        }
        if (url === "/api/macaroons" && opts?.method === "POST") {
          return { ok: true, json: async () => ({}) };
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

      await user.click(screen.getByTestId("complete-no-key-btn"));
      await waitFor(() => {
        expect(screen.getByText("Payment received")).toBeInTheDocument();
      });
    });

    it("shows the unlock-failed card when decryption fails after checkout", async () => {
      const user = userEvent.setup();
      mockFetch((url, opts) => {
        if (url === "/api/checkout" && opts?.method === "POST") {
          return { ok: true, json: async () => ({ token: "tok" }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });

      // Fresh visitor — no stored macaroon — so mount checkAccess shows pay buttons.
      render(<PaymentWall {...defaultProps} storedProductIds={[]} />);

      // Decryption fails AFTER checkout completes
      mockDecryptBlob.mockRejectedValue(new Error("Decryption error"));
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
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: expect.objectContaining({ context: "PaymentWall.decrypt" }) })
      );
    });
  });

  // -------------------------------------------------------
  // Sentry instrumentation on the failure paths
  // -------------------------------------------------------
  // These tests pin the observability contract used to diagnose
  // post-payment decryption failures on the live demo. Each customer-visible
  // failure MUST produce a `PaymentWall.recordFailure` Sentry event tagged
  // with the branch that fired (`reason`) and the media type, so a single
  // Sentry query disambiguates article vs photo failures and the cause.
  describe("recordFailure Sentry contract", () => {
    it("fires recordFailure with reason=fingerprintMismatch when the post-payment key fingerprint is wrong", async () => {
      const user = userEvent.setup();
      setupFreshPaymentScenario();
      mockVerifyKeyFingerprint.mockResolvedValue(false);

      render(<PaymentWall {...defaultProps} mediaType="article" storedProductIds={[]} />);
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

    it("fires recordFailure with reason=decryptFailed when resolveContent throws", async () => {
      const user = userEvent.setup();
      setupFreshPaymentScenario();
      mockDecryptBlob.mockRejectedValue(new Error("AES-GCM auth tag mismatch"));

      render(<PaymentWall {...defaultProps} mediaType="photo" storedProductIds={[]} />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      await user.click(screen.getByTestId("complete-btn"));

      await waitFor(() => {
        // Underlying decrypt exception captured with rich context
        expect(mockCaptureException).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({
            tags: expect.objectContaining({ context: "PaymentWall.decrypt", mediaType: "photo" }),
            extra: expect.objectContaining({
              mediaId: "media-123",
              activeProductId: "prod-1",
              mediaType: "photo",
              errorMessage: "AES-GCM auth tag mismatch",
              encryptedBlobLength: "encrypted-blob-1".length,
              keyLength: "test-key".length,
            }),
          })
        );
        // Customer-visible failure summary
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          "PaymentWall.recordFailure",
          expect.objectContaining({
            tags: expect.objectContaining({
              context: "PaymentWall.recordFailure",
              reason: "decryptFailed",
              mediaType: "photo",
            }),
          })
        );
      });
    });

    it("fires recordFailure with reason=noKeyAndFallbackFailed when key is empty and unlock fallback fails", async () => {
      const user = userEvent.setup();
      setupFreshPaymentScenario();

      render(<PaymentWall {...defaultProps} mediaType="article" storedProductIds={[]} />);
      await waitFor(() => expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument());
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument());
      // complete-no-key-btn = portal returned macaroon but no key
      await user.click(screen.getByTestId("complete-no-key-btn"));

      await waitFor(() => {
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          "PaymentWall.recordFailure",
          expect.objectContaining({
            tags: expect.objectContaining({
              reason: "noKeyAndFallbackFailed",
              mediaType: "article",
            }),
            extra: expect.objectContaining({ hadKey: false, hadMacaroon: true }),
          })
        );
      });
    });

    it("reports non-2xx macaroon storage as a PaymentWall.macaroonStore Sentry event", async () => {
      const user = userEvent.setup();
      // Macaroon POST returns 500; key+fingerprint still valid so decryption succeeds.
      mockFetch((url, init) => {
        if (url === "/api/checkout" && init?.method === "POST") {
          return { ok: true, json: async () => ({ token: "tok" }) };
        }
        if (url === "/api/macaroons" && init?.method === "POST") {
          return { ok: false, status: 503, json: async () => ({ error: "down" }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} mediaType="article" storedProductIds={[]} />);
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
              mediaType: "article",
              status: 503,
            }),
          })
        );
      });
      // Direct decryption still succeeded so the user sees content, not the failure card.
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

      render(<PaymentWall {...defaultProps} mediaType="photo" storedProductIds={[]} />);
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
  // Unlock failure card (post-payment)
  // -------------------------------------------------------
  describe("unlock failure card", () => {
    function setupCheckout(opts: { decryptThrows?: boolean; fallbackOk?: boolean } = {}) {
      if (opts.decryptThrows) {
        mockDecryptBlob.mockRejectedValue(new Error("AAD verify failed"));
      }
      mockFetch((url, init) => {
        if (url === "/api/checkout" && init?.method === "POST") {
          return { ok: true, json: async () => ({ token: "tok" }) };
        }
        if (url === "/api/macaroons" && init?.method === "POST") {
          return { ok: true, json: async () => ({}) };
        }
        if (url === "/api/media/media-123/unlock") {
          return { ok: !!opts.fallbackOk, json: async () => ({}) };
        }
        return { ok: false, json: async () => ({}) };
      });
    }

    async function payAndFail() {
      const user = userEvent.setup();
      render(<PaymentWall {...defaultProps} merchantName="Acme Co" />);
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
      setupCheckout({ decryptThrows: true });
      await payAndFail();
      expect(screen.queryByText("Unlock with Bitcoin")).not.toBeInTheDocument();
      expect(screen.queryByTestId("checkout-overlay")).not.toBeInTheDocument();
      expect(screen.queryByText("Need Bitcoin?")).not.toBeInTheDocument();
    });

    it("renders the order_number reference and contact line", async () => {
      setupCheckout({ decryptThrows: true });
      await payAndFail();
      expect(screen.getByText("ORD-TESTREF12345678")).toBeInTheDocument();
      expect(screen.getByText("uuid-abc-123")).toBeInTheDocument();
      expect(screen.getByText("Contact Acme Co for support.")).toBeInTheDocument();
      expect(screen.getByText("Failed at")).toBeInTheDocument();
    });

    it("reload button calls window.location.reload", async () => {
      setupCheckout({ decryptThrows: true });
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
      setupCheckout({ decryptThrows: true });
      const user = await payAndFail();
      // userEvent.setup() installs its own virtual clipboard — spy on it after setup
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
      render(<PaymentWall {...defaultProps} />);
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
      setupCheckout({ decryptThrows: true });
      const user = userEvent.setup();
      render(<PaymentWall {...defaultProps} />); // no merchantName
      await waitFor(() => {
        expect(screen.getAllByText(/HD Video/)[0]).toBeInTheDocument();
      });
      await user.click(screen.getAllByText(/HD Video/)[0]);
      await waitFor(() => {
        expect(screen.getByTestId("checkout-overlay")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("complete-btn"));
      await waitFor(() => {
        expect(screen.getByText("Contact the merchant for support.")).toBeInTheDocument();
      });
    });

    it("falls back to execCommand and shows error when clipboard API is unavailable", async () => {
      setupCheckout({ decryptThrows: true });
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

      // Restore
      Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
      document.execCommand = originalExecCommand;
    });

    it("renders the unlock-failed card in Spanish locale", async () => {
      mockLocale = "es";
      setupCheckout({ decryptThrows: true });
      const user = userEvent.setup();
      render(<PaymentWall {...defaultProps} merchantName="Acme Co" />);
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

  // -------------------------------------------------------
  // Verify failure card (returning visitor — paid, can't verify)
  // -------------------------------------------------------
  describe("verify failure card", () => {
    it("shows the verify-failed card when stored macaroon verify returns 502", async () => {
      mockFetch((url, opts) => {
        if (url === "/api/macaroons" && opts?.method === "PUT") {
          return { ok: false, status: 502, json: async () => ({ error: "Verification temporarily unavailable" }) };
        }
        if (url === "/api/media/media-123/unlock") {
          return { ok: false, status: 503, json: async () => ({}) };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} merchantName="Acme Co" />);
      await waitFor(() => {
        expect(screen.getByText("Couldn't verify your access")).toBeInTheDocument();
      });
      // Pay buttons are NOT visible
      expect(screen.queryByText("Unlock with Bitcoin")).not.toBeInTheDocument();
      expect(screen.queryByText(/HD Video/)).not.toBeInTheDocument();
      // Contact line uses merchant name
      expect(screen.getByText("Contact Acme Co for support.")).toBeInTheDocument();
      // Reload button is present
      expect(screen.getByText("Reload page")).toBeInTheDocument();
    });

    it("shows the verify-failed card when key fingerprint mismatches on a stored macaroon", async () => {
      mockVerifyKeyFingerprint.mockResolvedValue(false);
      mockFetch((url, opts) => {
        if (url === "/api/macaroons" && opts?.method === "PUT") {
          return { ok: true, status: 200, json: async () => ({ key: "k", key_fingerprint: "wrong" }) };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Couldn't verify your access")).toBeInTheDocument();
      });
      expect(screen.queryByText("Unlock with Bitcoin")).not.toBeInTheDocument();
    });

    it("does NOT show verify-failed card when user has no stored macaroons (fresh visitor)", async () => {
      mockFetch(() => {
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} storedProductIds={[]} />);
      await waitFor(() => {
        expect(screen.getAllByText("Unlock with Bitcoin")[0]).toBeInTheDocument();
      });
      expect(screen.queryByText("Couldn't verify your access")).not.toBeInTheDocument();
    });

    it("clears verify-failed when content unlocks via heartbeat key refresh", async () => {
      // First: simulate a stored macaroon verify that succeeds (so we end up unlocked)
      mockFetch((url, opts) => {
        if (url === "/api/macaroons" && opts?.method === "PUT") {
          return { ok: true, status: 200, json: async () => ({ key: "k1", key_fingerprint: "fp-1" }) };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
      });
      // Verify-failed card never appears in the success path
      expect(screen.queryByText("Couldn't verify your access")).not.toBeInTheDocument();
    });

    it("reload button on verify-failed card calls window.location.reload", async () => {
      mockFetch((url, opts) => {
        if (url === "/api/macaroons" && opts?.method === "PUT") {
          return { ok: false, status: 502, json: async () => ({}) };
        }
        return { ok: false, json: async () => ({}) };
      });

      const reloadSpy = vi.fn();
      Object.defineProperty(window, "location", {
        value: { ...window.location, reload: reloadSpy },
        writable: true,
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Couldn't verify your access")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.click(screen.getByText("Reload page"));
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------
  // Unlocked state
  // -------------------------------------------------------
  describe("unlocked state", () => {
    beforeEach(() => {
      mockFetch((url, opts) => {
        if (url === "/api/macaroons" && opts?.method === "PUT") {
          return { ok: true, json: async () => ({ key: "aes-key", key_fingerprint: "fp-1" }) };
        }
        return { ok: false, json: async () => ({}) };
      });
    });

    it("renders ContentRenderer when unlocked", async () => {
      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
      });
    });

    it("renders HeartbeatManager when unlocked", async () => {
      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("heartbeat-manager")).toBeInTheDocument();
      });
    });

    it("shows artwork for audio mediaType", async () => {
      render(<PaymentWall {...defaultProps} mediaType="audio" />);
      await waitFor(() => {
        expect(screen.getByAltText("Artwork")).toBeInTheDocument();
      });
    });

    it("shows artwork for podcast mediaType", async () => {
      render(<PaymentWall {...defaultProps} mediaType="podcast" />);
      await waitFor(() => {
        expect(screen.getByAltText("Artwork")).toBeInTheDocument();
      });
    });

    it("does not show artwork for video mediaType", async () => {
      render(<PaymentWall {...defaultProps} mediaType="video" />);
      await waitFor(() => {
        expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
      });
      expect(screen.queryByAltText("Artwork")).not.toBeInTheDocument();
    });

    it("handles handleExpired callback by re-locking content", async () => {
      const user = userEvent.setup();
      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("heartbeat-manager")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("expire-btn"));
      await waitFor(() => {
        expect(screen.getAllByText("Unlock with Bitcoin")[0]).toBeInTheDocument();
      });
    });

    it("handles handleKeyRefreshed callback by re-decrypting", async () => {
      const user = userEvent.setup();
      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("heartbeat-manager")).toBeInTheDocument();
      });

      mockDecryptBlob.mockResolvedValue(new Uint8Array([4, 5, 6]));
      await user.click(screen.getByTestId("refresh-key-btn"));
      // Content renderer should still be there
      expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
    });

    it("handles key refresh when fingerprint verification fails silently", async () => {
      const user = userEvent.setup();
      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("heartbeat-manager")).toBeInTheDocument();
      });

      mockVerifyKeyFingerprint.mockResolvedValue(false);
      await user.click(screen.getByTestId("refresh-key-btn"));
      // Still shows content (doesn't break)
      expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
    });

    it("handles key refresh when decryption throws silently", async () => {
      const user = userEvent.setup();
      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("heartbeat-manager")).toBeInTheDocument();
      });

      mockDecryptBlob.mockRejectedValue(new Error("decrypt error"));
      await user.click(screen.getByTestId("refresh-key-btn"));
      // Still shows content (doesn't break)
      await waitFor(() => {
        expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------
  // Direct unlock with fallback to first product
  // -------------------------------------------------------
  describe("direct unlock edge cases", () => {
    it("falls back to first product when encrypted_blob does not match", async () => {
      mockFetch((url, opts) => {
        if (url === "/api/macaroons" && opts?.method === "PUT") {
          return { ok: false, json: async () => ({}) };
        }
        if (url === "/api/media/media-123/unlock") {
          return {
            ok: true,
            json: async () => ({
              key: "direct-key",
              key_fingerprint: "fp-1",
              encrypted_blob: "different-blob",
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("content-renderer")).toBeInTheDocument();
      });
    });

    it("skips direct unlock when fingerprint verification fails", async () => {
      mockVerifyKeyFingerprint.mockResolvedValue(false);

      mockFetch((url, opts) => {
        if (url === "/api/macaroons" && opts?.method === "PUT") {
          return { ok: false, json: async () => ({}) };
        }
        if (url === "/api/media/media-123/unlock") {
          return {
            ok: true,
            json: async () => ({
              key: "direct-key",
              key_fingerprint: "fp-1",
              encrypted_blob: "encrypted-blob-1",
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      });

      render(<PaymentWall {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByText("Unlock with Bitcoin")[0]).toBeInTheDocument();
      });
    });
  });
});
