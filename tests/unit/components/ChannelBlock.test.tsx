// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/i18n/useLocale", () => ({
  useLocale: () => ({
    t: (key: string) => key,
    locale: "en",
  }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

import ChannelBlock from "@/components/ChannelBlock";

describe("ChannelBlock", () => {
  it("renders the channel name + a link to the channel page", () => {
    render(<ChannelBlock name="Platform Showcase" slug="platform-showcase" />);
    expect(screen.getByText("Platform Showcase")).toBeInTheDocument();
    const link = screen.getByText("Platform Showcase").closest("a");
    expect(link).toHaveAttribute("href", "/c/platform-showcase");
  });

  it("renders the channel avatar when profileImageUrl is provided", () => {
    render(
      <ChannelBlock
        name="Bitcoin Channel"
        slug="bitcoin"
        profileImageUrl="/api/images/avatar1"
      />
    );
    const img = screen.getByAltText("Bitcoin Channel");
    expect(img).toHaveAttribute("src", "/api/images/avatar1");
  });

  it("falls back to a single-letter initial when no avatar is provided", () => {
    render(<ChannelBlock name="Zara's Channel" slug="zara" />);
    // No img, just the initial letter.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Z")).toBeInTheDocument();
  });

  it("falls back to '?' when the channel name is empty", () => {
    render(<ChannelBlock name="" slug="empty" />);
    expect(screen.getByText("?")).toBeInTheDocument();
  });

  it("does not render a Subscribe button (Subscribe lives in ActionRow now)", () => {
    render(<ChannelBlock name="Test" slug="test" />);
    expect(screen.queryByTestId("subscribe-button")).not.toBeInTheDocument();
  });
});
