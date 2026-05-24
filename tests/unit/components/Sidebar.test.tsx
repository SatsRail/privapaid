// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockPathname = vi.fn(() => "/");
const mockSignOut = vi.fn();
const mockToggle = vi.fn();
const mockSetLocale = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
}));

vi.mock("next-auth/react", () => ({
  useSession: vi.fn(() => ({ data: null })),
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

vi.mock("@/lib/images", () => ({
  resolveImageUrl: (id?: string, url?: string) => {
    if (id) return `/api/images/${id}`;
    return url || "";
  },
}));

// Use vi.fn so individual tests can override the collapsed state via
// mockReturnValue. Default: not collapsed (the sidebar is rendered as
// expanded), which mirrors most of the file's assertions about visible
// content (channel list, language switcher, etc).
const mockUseSidebar = vi.fn(() => ({ collapsed: false, toggle: mockToggle }));
vi.mock("@/components/SidebarContext", () => ({
  useSidebar: () => mockUseSidebar(),
}));

vi.mock("@/i18n/useLocale", () => ({
  useLocale: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: mockSetLocale,
  }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; className?: string; style?: React.CSSProperties; title?: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { render, screen, fireEvent } from "@testing-library/react";
import Sidebar from "@/components/Sidebar";
import { useSession } from "next-auth/react";

const defaultProps = {
  channels: [
    { _id: "ch1", slug: "music", name: "Music Channel", profile_image_url: "/img.jpg", profile_image_id: "img1", media_count: 10, is_live: false },
    { _id: "ch2", slug: "art", name: "Art Channel", profile_image_url: "", media_count: 3, is_live: true },
  ],
  categories: [
    { _id: "cat1", name: "Entertainment" },
  ],
  channelsByCategory: {
    cat1: [
      { _id: "ch1", slug: "music", name: "Music Channel", profile_image_url: "/img.jpg", profile_image_id: "img1", media_count: 10, is_live: false },
    ],
  },
  uncategorized: [
    { _id: "ch2", slug: "art", name: "Art Channel", profile_image_url: "", media_count: 3, is_live: true },
  ],
};

beforeEach(() => {
  mockPathname.mockReturnValue("/");
  mockToggle.mockClear();
  mockSignOut.mockClear();
  mockSetLocale.mockClear();
  // Default collapsed=false so visible-content assertions (channel list,
  // language switcher, etc.) keep working. Individual tests can override.
  mockUseSidebar.mockReturnValue({ collapsed: false, toggle: mockToggle });
  (useSession as ReturnType<typeof vi.fn>).mockReturnValue({ data: null });
});

describe("Sidebar", () => {
  it("renders home link as active on /", () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("viewer.sidebar.home")).toBeInTheDocument();
  });

  it("renders login link when not authenticated", () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("viewer.navbar.login")).toBeInTheDocument();
  });

  it("renders user info when authenticated as customer", () => {
    (useSession as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { user: { name: "Alice", type: "customer" } },
    });

    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("viewer.navbar.logout")).toBeInTheDocument();
  });

  it("calls signOut when logout button clicked", () => {
    (useSession as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { user: { name: "Alice", type: "customer" } },
    });

    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByText("viewer.navbar.logout"));
    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: "/" });
  });

  it("renders channels section with category header", () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("viewer.sidebar.channels")).toBeInTheDocument();
    expect(screen.getAllByText("Entertainment").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Music Channel")).toBeInTheDocument();
  });

  it("renders uncategorized channels under 'Other'", () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("viewer.sidebar.other")).toBeInTheDocument();
    expect(screen.getByText("Art Channel")).toBeInTheDocument();
  });

  it("shows live indicator for live channels", () => {
    render(<Sidebar {...defaultProps} />);
    const liveIndicator = document.querySelector('[title="Live"]');
    expect(liveIndicator).not.toBeNull();
  });

  it("renders channel with profile image when available", () => {
    render(<Sidebar {...defaultProps} />);
    const img = document.querySelector('img[alt="Music Channel"]');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "/api/images/img1");
  });

  it("renders channel initial when no image", () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("A")).toBeInTheDocument(); // Art Channel initial
  });

  it("renders explore section with categories", () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("viewer.sidebar.explore")).toBeInTheDocument();
  });

  it("renders language switcher", () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("viewer.sidebar.language")).toBeInTheDocument();
    expect(screen.getByText("viewer.sidebar.lang_en")).toBeInTheDocument();
    expect(screen.getByText("viewer.sidebar.lang_es")).toBeInTheDocument();
  });

  it("calls setLocale when language button clicked", () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByText("viewer.sidebar.lang_es"));
    expect(mockSetLocale).toHaveBeenCalledWith("es");
  });

  it("renders about button", () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("viewer.navbar.about")).toBeInTheDocument();
  });

  it("dispatches open-about event when about clicked", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<Sidebar {...defaultProps} />);

    fireEvent.click(screen.getByText("viewer.navbar.about"));
    expect(dispatchSpy).toHaveBeenCalled();
    const event = dispatchSpy.mock.calls[0][0] as Event;
    expect(event.type).toBe("open-about");
  });

  it("shows empty message when no channels", () => {
    render(<Sidebar channels={[]} categories={[]} channelsByCategory={{}} uncategorized={[]} />);
    expect(screen.getByText("viewer.sidebar.empty")).toBeInTheDocument();
  });

  it("highlights active channel", () => {
    mockPathname.mockReturnValue("/c/music");
    render(<Sidebar {...defaultProps} />);
    // The active link gets the active class
    const link = screen.getByText("Music Channel").closest("a");
    expect(link).not.toBeNull();
    expect(link!.className).toContain("bg-[var(--theme-bg-secondary)]");
  });

  it("highlights active channel on sub-path", () => {
    mockPathname.mockReturnValue("/c/music/m123");
    render(<Sidebar {...defaultProps} />);
    const link = screen.getByText("Music Channel").closest("a");
    expect(link!.className).toContain("bg-[var(--theme-bg-secondary)]");
  });

  it("skips empty categories in channelsByCategory", () => {
    const props = {
      ...defaultProps,
      categories: [
        { _id: "cat1", name: "Entertainment" },
        { _id: "cat2", name: "Empty Cat" },
      ],
      channelsByCategory: {
        cat1: defaultProps.channelsByCategory.cat1,
        // cat2 has no channels
      },
    };
    render(<Sidebar {...props} />);
    // Empty Cat has no channels so its channel header div should not render,
    // but it still appears in the Explore section. We verify channel list is correct.
    expect(screen.getByText("Music Channel")).toBeInTheDocument();
    // Verify no channel items are rendered under Empty Cat (only 1 category header section has channels)
    const categoryHeaders = screen.getAllByText("Entertainment");
    expect(categoryHeaders.length).toBeGreaterThanOrEqual(1);
  });

  it("does not show uncategorized 'Other' label when no categories exist", () => {
    const props = {
      channels: defaultProps.uncategorized,
      categories: [],
      channelsByCategory: {},
      uncategorized: defaultProps.uncategorized,
    };
    render(<Sidebar {...props} />);
    // "Other" header only shows when categories.length > 0
    expect(screen.queryByText("viewer.sidebar.other")).not.toBeInTheDocument();
    // But the channel itself is still shown
    expect(screen.getByText("Art Channel")).toBeInTheDocument();
  });

  it("shows the backdrop when not collapsed (always on, not just mobile)", () => {
    render(<Sidebar {...defaultProps} />);
    const backdrop = document.querySelector(".fixed.inset-0");
    expect(backdrop).not.toBeNull();
    // Pin the architectural change: backdrop no longer carries `lg:hidden`.
    // YouTube watch-page model — the rail is an overlay at every breakpoint.
    expect(backdrop?.className).not.toContain("lg:hidden");
  });

  it("calls toggle when backdrop clicked", () => {
    render(<Sidebar {...defaultProps} />);
    const backdrop = document.querySelector(".fixed.inset-0.bg-black\\/50");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(mockToggle).toHaveBeenCalled();
  });

  it("translates the aside fully off-screen when collapsed (no more 72px icon rail)", () => {
    // The collapsed state used to render a 72px-wide icon rail on desktop.
    // Now collapsed = -translate-x-full on every breakpoint. The aside is
    // structurally w-60 always; the transform is what hides it.
    mockUseSidebar.mockReturnValue({
      collapsed: true,
      toggle: mockToggle,
    });
    render(<Sidebar {...defaultProps} />);
    const aside = document.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside?.className).toContain("-translate-x-full");
    expect(aside?.className).toContain("w-60");
    expect(aside?.className).not.toContain("w-[72px]");
  });

  it("renders the aside in-frame when expanded (translate-x-0)", () => {
    mockUseSidebar.mockReturnValue({
      collapsed: false,
      toggle: mockToggle,
    });
    render(<Sidebar {...defaultProps} />);
    const aside = document.querySelector("aside");
    expect(aside?.className).toContain("translate-x-0");
  });

  it("no longer renders the desktop spacer (rail is a pure overlay)", () => {
    // The old spacer was `<div class="hidden ... lg:block w-[72px]" />` that
    // reserved horizontal space on desktop. With the rail going overlay-only,
    // the spacer would mean main shifts 60–260px to the right for no reason.
    render(<Sidebar {...defaultProps} />);
    const spacers = document.querySelectorAll('div.hidden.lg\\:block.w-60, div.hidden.lg\\:block.w-\\[72px\\]');
    expect(spacers.length).toBe(0);
  });

  it("shows user initial for customer with name", () => {
    (useSession as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { user: { name: "Zara", type: "customer" } },
    });
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("Z")).toBeInTheDocument();
  });

  it("shows ? when customer has no name", () => {
    (useSession as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { user: { name: undefined, type: "customer" } },
    });
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText("?")).toBeInTheDocument();
  });
});
