// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/i18n", () => ({
  t: (_locale: string, key: string, vars?: Record<string, unknown>) => {
    if (vars?.count !== undefined) return `${key}:${vars.count}`;
    return key;
  },
}));

import MediaHeader from "@/components/MediaHeader";
import type { SerializedProduct } from "@/app/c/[slug]/[mediaId]/types";

const makeProduct = (overrides: Partial<SerializedProduct> = {}): SerializedProduct => ({
  productId: "p1",
  encryptedBlob: "blob",
  ...overrides,
});

describe("MediaHeader", () => {
  const baseProps = {
    name: "Test Media",
    products: [] as SerializedProduct[],
    viewsCount: 0,
    locale: "en",
  };

  it("renders the media name as h1", () => {
    render(<MediaHeader {...baseProps} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Test Media");
  });

  it("shows no price pill when there are no products", () => {
    render(<MediaHeader {...baseProps} />);
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument();
  });

  it("shows no price pill when products lack prices", () => {
    const products = [makeProduct({ priceCents: undefined })];
    render(<MediaHeader {...baseProps} products={products} />);
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument();
  });

  it("shows formatted price for a single product", () => {
    const products = [makeProduct({ priceCents: 500, currency: "USD" })];
    render(<MediaHeader {...baseProps} products={products} />);
    expect(screen.getByText("$5")).toBeInTheDocument();
  });

  it("shows price with decimals when not whole dollars", () => {
    const products = [makeProduct({ priceCents: 999, currency: "USD" })];
    render(<MediaHeader {...baseProps} products={products} />);
    expect(screen.getByText("$9.99")).toBeInTheDocument();
  });

  it("shows 'from' prefix with lowest price for multiple products", () => {
    const products = [
      makeProduct({ productId: "p1", priceCents: 1000, currency: "USD" }),
      makeProduct({ productId: "p2", priceCents: 500, currency: "USD" }),
    ];
    render(<MediaHeader {...baseProps} products={products} />);
    expect(screen.getByText(/viewer\.media\.from/)).toBeInTheDocument();
    expect(screen.getByText(/\$5/)).toBeInTheDocument();
  });

  it("never renders the views counter — that moved to MediaMeta under the content", () => {
    // YouTube-style placement: the views counter lives under the player,
    // not next to the title. Header stays tight with just title + pills.
    // The prop is still accepted for backward compatibility but ignored.
    render(<MediaHeader {...baseProps} viewsCount={42} />);
    expect(screen.queryByText(/viewer\.media\.views/)).not.toBeInTheDocument();
  });

  it("renders the access timer pill when remainingSeconds is set and a product is time-gated", () => {
    const products = [makeProduct({ accessDurationSeconds: 86400 })];
    render(<MediaHeader {...baseProps} products={products} remainingSeconds={3600} />);
    expect(screen.getByText(/viewer\.media\.access_label/)).toBeInTheDocument();
  });

  it("does not render the access timer pill when no product is time-gated", () => {
    const products = [makeProduct({ priceCents: 100 })];
    render(<MediaHeader {...baseProps} products={products} remainingSeconds={3600} />);
    expect(screen.queryByText(/viewer\.media\.access_label/)).not.toBeInTheDocument();
  });

  it("does not render the access timer pill when remainingSeconds is null", () => {
    const products = [makeProduct({ accessDurationSeconds: 86400 })];
    render(<MediaHeader {...baseProps} products={products} remainingSeconds={null} />);
    expect(screen.queryByText(/viewer\.media\.access_label/)).not.toBeInTheDocument();
  });

  describe("Lifetime tag", () => {
    it("renders the Lifetime tag when a product has no accessDurationSeconds", () => {
      const products = [makeProduct({ priceCents: 100 })];
      render(<MediaHeader {...baseProps} products={products} />);
      expect(screen.getByTestId("lifetime-tag")).toBeInTheDocument();
      expect(screen.getByTestId("lifetime-tag")).toHaveTextContent("viewer.payment.lifetime");
    });

    it("does not render the Lifetime tag when there are no products", () => {
      render(<MediaHeader {...baseProps} />);
      expect(screen.queryByTestId("lifetime-tag")).not.toBeInTheDocument();
    });

    it("does not render the Lifetime tag when any product is time-gated", () => {
      const products = [
        makeProduct({ productId: "p1", accessDurationSeconds: 86400 }),
        makeProduct({ productId: "p2" }), // lifetime
      ];
      render(<MediaHeader {...baseProps} products={products} remainingSeconds={3600} />);
      expect(screen.queryByTestId("lifetime-tag")).not.toBeInTheDocument();
      // Timer takes precedence
      expect(screen.getByText(/viewer\.media\.access_label/)).toBeInTheDocument();
    });

    it("renders Lifetime tag alongside the price pill for a lifetime product the viewer has NOT paid for", () => {
      const products = [makeProduct({ priceCents: 500, currency: "USD" })];
      render(<MediaHeader {...baseProps} products={products} />);
      expect(screen.getByTestId("lifetime-tag")).toBeInTheDocument();
      expect(screen.getByText("$5")).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------
  // Access pill swap — the price pill disappears once the viewer
  // has active access; the access clock or lifetime tag takes
  // the visual slot. Founder framing: "if the user paid for
  // something, the price should go away and the access clock
  // should take that spot."
  // -----------------------------------------------------------
  describe("price → access swap when viewer holds an active macaroon", () => {
    it("time-gated: shows the clock and HIDES the price once remainingSeconds is positive", () => {
      const products = [
        makeProduct({ accessDurationSeconds: 604800, priceCents: 100, currency: "USD" }),
      ];
      render(<MediaHeader {...baseProps} products={products} remainingSeconds={604800} />);
      // Clock visible
      expect(screen.getByText(/viewer\.media\.access_label/)).toBeInTheDocument();
      // Price hidden — they've already paid
      expect(screen.queryByText("$1")).not.toBeInTheDocument();
    });

    it("time-gated: still shows the price BEFORE payment (remainingSeconds undefined)", () => {
      const products = [
        makeProduct({ accessDurationSeconds: 604800, priceCents: 100, currency: "USD" }),
      ];
      render(<MediaHeader {...baseProps} products={products} />);
      expect(screen.queryByText(/viewer\.media\.access_label/)).not.toBeInTheDocument();
      expect(screen.getByText("$1")).toBeInTheDocument();
    });

    it("lifetime: hides the price once the viewer has paid (remainingSeconds set), keeps the lifetime tag", () => {
      // Portal returns a 30-day TTL even for lifetime products. Any positive
      // remainingSeconds at the header layer means "viewer has paid."
      const products = [makeProduct({ priceCents: 500, currency: "USD" })];
      render(<MediaHeader {...baseProps} products={products} remainingSeconds={2_592_000} />);
      expect(screen.getByTestId("lifetime-tag")).toBeInTheDocument();
      expect(screen.queryByText("$5")).not.toBeInTheDocument();
    });

    it("treats remainingSeconds=0 as unpaid (expired) — price returns, clock hidden", () => {
      const products = [
        makeProduct({ accessDurationSeconds: 604800, priceCents: 100, currency: "USD" }),
      ];
      render(<MediaHeader {...baseProps} products={products} remainingSeconds={0} />);
      expect(screen.queryByText(/viewer\.media\.access_label/)).not.toBeInTheDocument();
      expect(screen.getByText("$1")).toBeInTheDocument();
    });
  });
});
