// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/i18n", () => ({
  // Identity-ish mock — surfaces the key and the count so we can assert.
  t: (_locale: string, key: string, params?: Record<string, string | number>) =>
    params?.count != null ? `${key}:${params.count}` : key,
}));

// Surface Next's `prefetch` prop as a data-attribute so tests can assert
// on it (React drops unknown attributes from <a>).
vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, prefetch, ...rest }: { children: React.ReactNode; href: string; prefetch?: boolean }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>{children}</a>
  ),
}));

import ChannelSidebarItem from "@/components/ChannelSidebarItem";

const baseItem = {
  _id: "media-1",
  name: "How to set up your Lightning node",
  thumbnailSrc: "/api/images/thumb1",
  mediaType: "video",
  viewsCount: 1234,
  href: "/c/platform-showcase/media-1",
  // Recent enough that any reasonable "ago" rendering shows.
  createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
};

describe("ChannelSidebarItem", () => {
  it("links to the item's href", () => {
    render(<ChannelSidebarItem item={baseItem} locale="en" />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/c/platform-showcase/media-1");
  });

  it("renders the title", () => {
    render(<ChannelSidebarItem item={baseItem} locale="en" />);
    expect(screen.getByText("How to set up your Lightning node")).toBeInTheDocument();
  });

  it("renders the thumbnail with the item name as alt text", () => {
    render(<ChannelSidebarItem item={baseItem} locale="en" />);
    const img = screen.getByAltText("How to set up your Lightning node");
    expect(img).toHaveAttribute("src", "/api/images/thumb1");
  });

  it("renders the localized view count + relative time joined by a dot — YouTube's exact sub-label format", () => {
    render(<ChannelSidebarItem item={baseItem} locale="en" />);
    // Joint format: "<views> • <relative time>". The relative-time value
    // is rendered by Intl.RelativeTimeFormat and includes "day"/"days".
    const subLabel = screen.getByText(/viewer\.media\.views:1234.*•.*day/);
    expect(subLabel).toBeInTheDocument();
  });

  it("hides the view count when zero but still shows the relative time", () => {
    // YouTube freshness signal — even 0 views should show "uploaded 5
    // minutes ago" so the recommendation feels alive. We just drop the
    // "0 views" half and keep the time half.
    render(
      <ChannelSidebarItem
        item={{ ...baseItem, viewsCount: 0 }}
        locale="en"
      />
    );
    expect(screen.queryByText(/viewer\.media\.views:0/)).not.toBeInTheDocument();
    expect(screen.getByText(/day/)).toBeInTheDocument();
  });

  it("falls back to a placeholder when thumbnailSrc is missing", () => {
    render(
      <ChannelSidebarItem
        item={{ ...baseItem, thumbnailSrc: undefined }}
        locale="en"
      />
    );
    // Placeholder shows the media type so the row isn't empty.
    expect(screen.getByText("video")).toBeInTheDocument();
    expect(screen.queryByAltText(/Lightning node/)).not.toBeInTheDocument();
  });

  it("applies line-clamp-2 to the title (long titles don't blow up the row)", () => {
    const long = "A very long title ".repeat(20).trim();
    render(<ChannelSidebarItem item={{ ...baseItem, name: long }} locale="en" />);
    const titleEl = screen.getByText(long);
    expect(titleEl.className).toContain("line-clamp-2");
  });

  it("uses prefetch=false on the Link (avoids burning bandwidth on 20-item sidebars)", () => {
    const { container } = render(<ChannelSidebarItem item={baseItem} locale="en" />);
    const link = container.querySelector("a");
    // The next/link mock above forwards prefetch as data-prefetch so we
    // can pin the optimization choice without depending on Next's internals.
    expect(link?.getAttribute("data-prefetch")).toBe("false");
  });
});
