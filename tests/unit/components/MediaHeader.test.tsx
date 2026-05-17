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
    commentsCount: 0,
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

  it("hides views when count is 0", () => {
    render(<MediaHeader {...baseProps} viewsCount={0} />);
    expect(screen.queryByText(/viewer\.media\.views/)).not.toBeInTheDocument();
  });

  it("shows views when count is greater than 0", () => {
    render(<MediaHeader {...baseProps} viewsCount={42} />);
    expect(screen.getByText("viewer.media.views:42")).toBeInTheDocument();
  });

  it("never renders the comments line (it lives in the comments section heading)", () => {
    render(<MediaHeader {...baseProps} commentsCount={7} />);
    expect(screen.queryByText(/viewer\.media\.comments/)).not.toBeInTheDocument();
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

    it("renders Lifetime tag alongside the price pill for a lifetime product", () => {
      const products = [makeProduct({ priceCents: 500, currency: "USD" })];
      render(<MediaHeader {...baseProps} products={products} />);
      expect(screen.getByTestId("lifetime-tag")).toBeInTheDocument();
      expect(screen.getByText("$5")).toBeInTheDocument();
    });
  });
});
