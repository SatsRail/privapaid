// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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

beforeEach(() => {
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((k: string) => store[k] ?? null),
    setItem: vi.fn((k: string, v: string) => { store[k] = v; }),
    removeItem: vi.fn((k: string) => { delete store[k]; }),
  });
});

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

  it("renders the Subscribe button in the unsubscribed state on first mount", () => {
    render(<ChannelBlock name="Test" slug="test" />);
    expect(screen.getByTestId("subscribe-button")).toHaveTextContent("viewer.channel.subscribe");
  });

  it("toggles to 'Subscribed' on click and writes to localStorage", () => {
    render(<ChannelBlock name="Test" slug="test-toggle" />);
    fireEvent.click(screen.getByTestId("subscribe-button"));
    expect(screen.getByTestId("subscribe-button")).toHaveTextContent("viewer.channel.subscribed");
    expect(localStorage.setItem).toHaveBeenCalledWith("privapaid:subscribed:test-toggle", "true");
  });

  it("toggles back to 'Subscribe' on second click and removes the localStorage key", () => {
    render(<ChannelBlock name="Test" slug="test-untoggle" />);
    const btn = screen.getByTestId("subscribe-button");
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("viewer.channel.subscribe");
    expect(localStorage.removeItem).toHaveBeenCalledWith("privapaid:subscribed:test-untoggle");
  });

  it("hydrates 'Subscribed' state from localStorage on mount", async () => {
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue("true");
    render(<ChannelBlock name="Test" slug="test-hydrate" />);
    // useEffect runs after first render — the hydrated state shows up on the next paint.
    await Promise.resolve();
    expect(screen.getByTestId("subscribe-button")).toHaveTextContent("viewer.channel.subscribed");
  });
});
