// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/i18n", () => ({
  // Tests don't need real i18n strings — just an identity mapping that
  // surfaces the key + count so we can assert the visible content.
  t: (_locale: string, key: string, params?: Record<string, string | number>) =>
    params?.count != null ? `${key}:${params.count}` : key,
}));

import MediaMeta from "@/components/MediaMeta";

describe("MediaMeta", () => {
  it("renders the views count when greater than 0", () => {
    render(<MediaMeta viewsCount={42} locale="en" />);
    expect(screen.getByText("viewer.media.views:42")).toBeInTheDocument();
  });

  it("renders nothing when views count is 0", () => {
    // Fresh upload: no views yet → nothing to say. Don't surface "0 views"
    // since it's noise. Pinning this behavior because it's the contract
    // MediaLayout depends on for the empty state.
    const { container } = render(<MediaMeta viewsCount={0} locale="en" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for negative counts (defensive)", () => {
    const { container } = render(<MediaMeta viewsCount={-1} locale="en" />);
    expect(container.firstChild).toBeNull();
  });
});
