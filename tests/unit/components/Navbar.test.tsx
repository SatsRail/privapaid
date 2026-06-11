// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPathname = vi.fn(() => "/");
const mockToggle = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
}));

vi.mock("@/i18n/useLocale", () => ({
  useLocale: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

vi.mock("@/components/SidebarContext", () => ({
  useSidebar: () => ({ collapsed: false, toggle: mockToggle }),
}));

vi.mock("@/components/SearchBar", () => ({
  default: () => <div data-testid="search-bar">SearchBar</div>,
}));

vi.mock("@/components/AboutModal", () => ({
  default: ({ open, aboutText, instanceName }: { open: boolean; onClose: () => void; aboutText: string; instanceName: string }) => {
    if (!open) return null;
    return <div data-testid="about-modal">{instanceName}: {aboutText}</div>;
  },
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { render, screen, fireEvent, act } from "@testing-library/react";
import Navbar from "@/components/Navbar";

const defaultProps = {
  instanceName: "TestStream",
  logoUrl: "https://example.com/logo.png",
  aboutText: "About this stream",
};

beforeEach(() => {
  mockPathname.mockReturnValue("/");
  mockToggle.mockClear();
});

describe("Navbar", () => {
  it("renders navbar with instance name and logo", () => {
    render(<Navbar {...defaultProps} />);
    expect(screen.getByText("TestStream")).toBeInTheDocument();
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.src).toBe("https://example.com/logo.png");
  });

  it("renders initial letter when no logoUrl", () => {
    render(<Navbar {...defaultProps} logoUrl="" />);
    expect(screen.getByText("T")).toBeInTheDocument();
  });

  it("renders search bar", () => {
    render(<Navbar {...defaultProps} />);
    expect(screen.getByTestId("search-bar")).toBeInTheDocument();
  });

  it("calls toggle when hamburger button clicked", () => {
    render(<Navbar {...defaultProps} />);
    const toggleBtn = screen.getByLabelText("Toggle sidebar");
    fireEvent.click(toggleBtn);
    expect(mockToggle).toHaveBeenCalledTimes(1);
  });

  it("returns null on hidden paths", () => {
    mockPathname.mockReturnValue("/setup");
    const { container } = render(<Navbar {...defaultProps} />);
    expect(container.querySelector("nav")).toBeNull();
  });

  it("returns null on hidden sub-paths", () => {
    mockPathname.mockReturnValue("/admin/dashboard");
    const { container } = render(<Navbar {...defaultProps} />);
    expect(container.querySelector("nav")).toBeNull();
  });

  it("returns null on /login", () => {
    mockPathname.mockReturnValue("/login");
    const { container } = render(<Navbar {...defaultProps} />);
    expect(container.querySelector("nav")).toBeNull();
  });

  it("renders on non-hidden paths", () => {
    mockPathname.mockReturnValue("/c/some-channel");
    render(<Navbar {...defaultProps} />);
    expect(screen.getByText("TestStream")).toBeInTheDocument();
  });

  it("opens about modal on 'open-about' event", () => {
    render(<Navbar {...defaultProps} />);
    expect(screen.queryByTestId("about-modal")).toBeNull();

    act(() => {
      window.dispatchEvent(new Event("open-about"));
    });
    expect(screen.getByTestId("about-modal")).toBeInTheDocument();
  });

  it("links home via logo", () => {
    render(<Navbar {...defaultProps} />);
    const homeLink = screen.getByText("TestStream").closest("a");
    expect(homeLink).toHaveAttribute("href", "/");
  });
});
