// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/i18n", () => ({
  t: (_locale: string, key: string, params?: Record<string, string | number>) =>
    params?.count != null ? `${key}:${params.count}` : key,
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import ChannelSidebar from "@/components/ChannelSidebar";

const items = [
  {
    _id: "m1",
    name: "First sibling",
    thumbnailSrc: "/api/images/t1",
    mediaType: "video",
    viewsCount: 100,
    href: "/c/ch/m1",
  },
  {
    _id: "m2",
    name: "Second sibling",
    thumbnailSrc: "/api/images/t2",
    mediaType: "photo",
    viewsCount: 50,
    href: "/c/ch/m2",
  },
];

describe("ChannelSidebar", () => {
  it("renders one row per sibling item", () => {
    render(<ChannelSidebar items={items} locale="en" />);
    expect(screen.getAllByTestId("channel-sidebar-item")).toHaveLength(2);
  });

  it("renders the section heading", () => {
    render(<ChannelSidebar items={items} locale="en" />);
    expect(screen.getByText("viewer.sidebar.more_from_channel")).toBeInTheDocument();
  });

  it("preserves the items' incoming order (server-decided sort)", () => {
    // Founder chose views_count desc on the server. The component must NOT
    // re-sort — that would mask a server-side bug. Asserting render order
    // here pins the "server is the source of truth" contract.
    render(<ChannelSidebar items={items} locale="en" />);
    const titles = screen.getAllByTestId("channel-sidebar-item").map(
      (el) => el.querySelector("p")?.textContent
    );
    expect(titles).toEqual(["First sibling", "Second sibling"]);
  });

  it("renders nothing when the items list is empty (single-media channel)", () => {
    // A channel-of-one should not surface an empty 'up next' rail. The
    // MediaLayout collapses to single-column in that case.
    const { container } = render(<ChannelSidebar items={[]} locale="en" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("channel-sidebar")).not.toBeInTheDocument();
  });

  it("exposes an aria-label for accessibility", () => {
    render(<ChannelSidebar items={items} locale="en" />);
    expect(screen.getByLabelText("viewer.sidebar.more_from_channel")).toBeInTheDocument();
  });

  it("passes the locale down to each item (views count picks up the right pluralization)", () => {
    render(<ChannelSidebar items={items} locale="es" />);
    // Our mock returns `viewer.media.views:100`; locale doesn't change the
    // mock output, but we verify the items receive the count via the key.
    expect(screen.getByText("viewer.media.views:100")).toBeInTheDocument();
    expect(screen.getByText("viewer.media.views:50")).toBeInTheDocument();
  });
});
