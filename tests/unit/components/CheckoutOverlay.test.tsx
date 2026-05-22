// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// --- Mocks ---

const mockCaptureException = vi.fn();
const mockCaptureMessage = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

vi.mock("@/i18n/useLocale", async () => {
  const { t: realT } = await import("@/i18n");
  const boundT = (key: string, params?: Record<string, string | number>) => realT("en", key, params);
  return { useLocale: () => ({ t: boundT, locale: "en" }) };
});

import CheckoutOverlay from "@/components/CheckoutOverlay";

const defaultProps = {
  checkoutToken: "tok-123",
  onComplete: vi.fn(),
  onClose: vi.fn(),
};

describe("CheckoutOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Default fetch mocks
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/qr")) {
        return { ok: true, text: async () => '<svg data-testid="qr">QR</svg>' };
      }
      if (typeof url === "string" && url.includes("/status")) {
        return {
          ok: true,
          json: async () => ({
            status: "pending",
            payment_request: "lnbc1234",
            time_remaining: 300,
            amount_sats: 500,
            amount_cents: 250,
            currency: "USD",
          }),
        };
      }
      return { ok: false };
    });

    // Mock clipboard
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------
  // Pending state
  // -------------------------------------------------------
  describe("pending state", () => {
    it("renders QR code after loading", async () => {
      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Waiting for payment...")).toBeInTheDocument();
      });
    });

    it("renders QR SVG when loaded", async () => {
      const { container } = render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        const svgContainer = container.querySelector("[class*='bg-white']");
        expect(svgContainer?.innerHTML).toContain("QR");
      });
    });

    it("shows loading spinner before QR loads", () => {
      // Make QR fetch hang
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return new Promise(() => {}); // Never resolves
        }
        if (typeof url === "string" && url.includes("/status")) {
          return { ok: true, json: async () => ({ status: "pending" }) };
        }
        return { ok: false };
      });

      const { container } = render(<CheckoutOverlay {...defaultProps} />);
      // Should show spinner (animate-spin class)
      const spinner = container.querySelector(".animate-spin");
      expect(spinner).toBeTruthy();
    });

    it("shows fiat price and sats amount", async () => {
      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("$2.50")).toBeInTheDocument();
        expect(screen.getByText("500 sats")).toBeInTheDocument();
      });
    });

    it("shows sats-only price when no fiat amount", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({
              status: "pending",
              amount_sats: 1000,
            }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText(/1,000/)).toBeInTheDocument();
        expect(screen.getByText("sats")).toBeInTheDocument();
      });
    });

    it("shows timer countdown", async () => {
      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("5:00")).toBeInTheDocument();
      });
    });

    it("counts down timer", async () => {
      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("5:00")).toBeInTheDocument();
      });

      // Advance in individual 1s steps so each interval tick is flushed
      // through React's state update cycle before the next fires.
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          vi.advanceTimersByTime(1000);
        });
      }

      await waitFor(() => {
        // Timer should have ticked down from 5:00
        expect(screen.queryByText("5:00")).not.toBeInTheDocument();
        expect(screen.getByText(/^4:5\d$/)).toBeInTheDocument();
      });
    });

    it("shows Copy Invoice and Open Wallet buttons", async () => {
      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Copy Invoice")).toBeInTheDocument();
        expect(screen.getByText("Open Wallet")).toBeInTheDocument();
      });
    });

    it("Open Wallet links to lightning: protocol", async () => {
      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        const walletLink = screen.getByText("Open Wallet").closest("a");
        expect(walletLink).toHaveAttribute("href", "lightning:lnbc1234");
      });
    });

    it("copies payment request to clipboard", async () => {
      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Copy Invoice")).toBeInTheDocument();
      });

      // Use fireEvent instead of userEvent to avoid fake timer conflicts
      await act(async () => {
        screen.getByText("Copy Invoice").click();
      });

      // Allow the promise chain to settle
      await act(async () => {
        await Promise.resolve();
      });

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("lnbc1234");
      expect(screen.getByText("Copied!")).toBeInTheDocument();

      // "Copied!" text reverts after 2 seconds
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText("Copy Invoice")).toBeInTheDocument();
    });

    it("shows Cancel button that calls onClose", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Cancel")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Cancel"));
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("shows powered by SatsRail link", async () => {
      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        const link = screen.getByText("powered by SatsRail.com");
        expect(link).toHaveAttribute("href", "https://satsrail.com");
        expect(link).toHaveAttribute("target", "_blank");
      });
    });

    it("shows merchant logo when provided", async () => {
      render(
        <CheckoutOverlay
          {...defaultProps}
          merchantLogo="https://example.com/logo.png"
          merchantName="Test Shop"
        />
      );
      await waitFor(() => {
        const logo = screen.getByAltText("Test Shop");
        expect(logo).toHaveAttribute("src", "https://example.com/logo.png");
      });
    });

    it("shows default lightning icon when no merchant logo", async () => {
      const { container } = render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        const svg = container.querySelector("polygon[points*='13 2']");
        expect(svg).toBeTruthy();
      });
    });

    it("shows fiat price from props when provided", async () => {
      // Status does not return fiat info, but props have it
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({
              status: "pending",
              amount_sats: 500,
            }),
          };
        }
        return { ok: false };
      });

      render(
        <CheckoutOverlay
          {...defaultProps}
          priceCents={999}
          priceCurrency="USD"
        />
      );
      await waitFor(() => {
        expect(screen.getByText("$9.99")).toBeInTheDocument();
      });
    });

    it("does not show payment request buttons before status returns one", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return { ok: true, json: async () => ({ status: "pending" }) };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Waiting for payment...")).toBeInTheDocument();
      });
      expect(screen.queryByText("Copy Invoice")).not.toBeInTheDocument();
    });

    it("handleCopy does nothing when no paymentRequest", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return { ok: true, json: async () => ({ status: "pending" }) };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Waiting for payment...")).toBeInTheDocument();
      });
      // No copy button should exist, so clipboard should not be called
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------
  // Completed state
  // -------------------------------------------------------
  describe("completed state", () => {
    it("calls onComplete when payment is completed", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({
              status: "completed",
              items: [{ key: "decryption-key" }],
              access_token: "macaroon-token",
              access_duration_seconds: 3600,
            }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(defaultProps.onComplete).toHaveBeenCalledWith({
          key: "decryption-key",
          macaroon: "macaroon-token",
          remaining_seconds: 3600,
          order_number: null,
          order_id: null,
        });
      });
    });

    it("propagates order_number and order_id when present", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({
              status: "completed",
              items: [{ key: "decryption-key" }],
              access_token: "macaroon-token",
              access_duration_seconds: 86400,
              order_number: "ORD-ABCDEF1234567890",
              order_id: "uuid-123",
            }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(defaultProps.onComplete).toHaveBeenCalledWith({
          key: "decryption-key",
          macaroon: "macaroon-token",
          remaining_seconds: 86400,
          order_number: "ORD-ABCDEF1234567890",
          order_id: "uuid-123",
        });
      });
    });

    it("logs a warning-level CheckoutOverlay.completed event when key is missing", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({
              status: "completed",
              items: [{ key: "" }],
              access_token: "macaroon-token",
              order_id: "uuid-missing-key",
              order_number: "ORD-MISSING-KEY",
            }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          "CheckoutOverlay.completed",
          expect.objectContaining({
            level: "warning",
            tags: { context: "CheckoutOverlay.completed" },
            extra: expect.objectContaining({
              hasKey: false,
              hasMacaroon: true,
              keyLength: 0,
              macaroonLength: 14,
              orderId: "uuid-missing-key",
              orderNumber: "ORD-MISSING-KEY",
            }),
          })
        );
      });
    });

    it("logs a warning-level CheckoutOverlay.completed event when access_token is missing", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({
              status: "completed",
              items: [{ key: "valid-key" }],
            }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          "CheckoutOverlay.completed",
          expect.objectContaining({
            level: "warning",
            extra: expect.objectContaining({ hasKey: true, hasMacaroon: false }),
          })
        );
      });
    });

    it("logs an info-level CheckoutOverlay.completed event when both key and macaroon are present", async () => {
      // Even on a healthy completion we emit one event so the Sentry trail
      // disambiguates "portal returned the right payload" vs. "portal returned
      // junk" when the customer later reports a failure.
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({
              status: "completed",
              items: [{ key: "valid-key" }],
              access_token: "valid-macaroon",
              order_id: "uuid-ok",
              order_number: "ORD-OK",
              access_duration_seconds: 86400,
            }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(defaultProps.onComplete).toHaveBeenCalled();
      });
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        "CheckoutOverlay.completed",
        expect.objectContaining({
          level: "info",
          tags: { context: "CheckoutOverlay.completed" },
          extra: expect.objectContaining({
            hasKey: true,
            hasMacaroon: true,
            orderId: "uuid-ok",
            orderNumber: "ORD-OK",
            accessDurationSeconds: 86400,
          }),
        })
      );
    });

    it("handles completed status with missing data gracefully", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({ status: "completed" }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(defaultProps.onComplete).toHaveBeenCalledWith({
          key: "",
          macaroon: "",
          remaining_seconds: 0,
          order_number: null,
          order_id: null,
        });
      });
    });
  });

  // -------------------------------------------------------
  // Expired state
  // -------------------------------------------------------
  describe("expired state", () => {
    it("shows expired message", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({ status: "expired" }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Invoice expired. Please try again.")).toBeInTheDocument();
      });
    });

    it("expired close button calls onClose", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({ status: "expired" }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Invoice expired. Please try again.")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Close"));
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------
  // Error state
  // -------------------------------------------------------
  describe("error state", () => {
    it("shows error message when QR fetch fails", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: false, status: 500, text: async () => "" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return { ok: true, json: async () => ({ status: "pending" }) };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Failed to load payment. Please try again.")).toBeInTheDocument();
      });
      expect(mockCaptureException).toHaveBeenCalled();
    });

    it("error close button calls onClose", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          throw new Error("Network error");
        }
        if (typeof url === "string" && url.includes("/status")) {
          return { ok: true, json: async () => ({ status: "pending" }) };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Failed to load payment. Please try again.")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Close"));
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------
  // Polling behavior
  // -------------------------------------------------------
  describe("polling", () => {
    it("polls status every 3 seconds", async () => {
      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Waiting for payment...")).toBeInTheDocument();
      });

      const initialCallCount = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: string[]) => typeof c[0] === "string" && c[0].includes("/status")
      ).length;

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      const newCallCount = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: string[]) => typeof c[0] === "string" && c[0].includes("/status")
      ).length;

      expect(newCallCount).toBeGreaterThan(initialCallCount);
    });

    it("ignores transient poll errors", async () => {
      let callCount = 0;
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          callCount++;
          if (callCount === 2) throw new Error("Transient error");
          return { ok: true, json: async () => ({ status: "pending" }) };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Waiting for payment...")).toBeInTheDocument();
      });

      // Advance to trigger another poll
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      // Should still show pending, not error
      expect(screen.getByText("Waiting for payment...")).toBeInTheDocument();
    });

    it("ignores poll responses with non-ok status", async () => {
      let callCount = 0;
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          callCount++;
          if (callCount >= 2) return { ok: false };
          return { ok: true, json: async () => ({ status: "pending" }) };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Waiting for payment...")).toBeInTheDocument();
      });

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      // Should still be pending
      expect(screen.getByText("Waiting for payment...")).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------
  // formatTime utility
  // -------------------------------------------------------
  describe("formatTime", () => {
    it("formats seconds with leading zero", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({
              status: "pending",
              time_remaining: 65,
            }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("1:05")).toBeInTheDocument();
      });
    });

    it("formats zero time correctly", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({
              status: "pending",
              time_remaining: 0,
            }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Waiting for payment...")).toBeInTheDocument();
      });
      // Timer should NOT be shown when time_remaining is 0
      expect(screen.queryByText("0:00")).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------
  // formatFiat utility
  // -------------------------------------------------------
  describe("formatFiat", () => {
    it("formats even dollar amounts without decimals", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({
              status: "pending",
              amount_cents: 1000,
              currency: "USD",
            }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("$10")).toBeInTheDocument();
      });
    });

    it("formats cents with decimals", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({
              status: "pending",
              amount_cents: 1050,
              currency: "USD",
            }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("$10.50")).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------
  // Timer countdown edge cases
  // -------------------------------------------------------
  describe("timer countdown", () => {
    it("stops timer at 0", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.includes("/qr")) {
          return { ok: true, text: async () => "<svg>QR</svg>" };
        }
        if (typeof url === "string" && url.includes("/status")) {
          return {
            ok: true,
            json: async () => ({
              status: "pending",
              payment_request: "lnbc1234",
              time_remaining: 2,
            }),
          };
        }
        return { ok: false };
      });

      render(<CheckoutOverlay {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("0:02")).toBeInTheDocument();
      });

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByText("0:01")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      // Timer should have stopped at 0
      expect(screen.queryByText("0:00")).not.toBeInTheDocument();
    });
  });
});
