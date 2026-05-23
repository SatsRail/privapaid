// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MediaPageData } from "@/app/c/[slug]/[mediaId]/types";

vi.mock("@/components/MediaBreadcrumb", () => ({
  default: (props: { mediaName: string }) => <div data-testid="breadcrumb">{props.mediaName}</div>,
}));
vi.mock("@/components/MediaHeader", () => ({
  default: (props: { name: string }) => <div data-testid="header">{props.name}</div>,
}));
vi.mock("@/components/UnavailableWall", () => ({
  default: (props: { variant: string }) => <div data-testid="unavailable-wall">{props.variant}</div>,
}));
vi.mock("@/components/PaymentWall", () => ({
  default: (props: { mediaId: string }) => <div data-testid="payment-wall">{props.mediaId}</div>,
}));
vi.mock("@/components/PreviewGallery", () => ({
  default: (props: { images: string[] }) => <div data-testid="preview-gallery">{props.images.length} images</div>,
}));
vi.mock("@/components/CommentSection", () => ({
  default: (props: { mediaId: string }) => <div data-testid="comment-section">{props.mediaId}</div>,
}));
vi.mock("@/components/ErrorBoundary", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="error-boundary">{children}</div>,
}));
vi.mock("@/components/AdminPreviewBanner", () => ({
  default: (props: { mediaName: string }) => <div data-testid="admin-banner">{props.mediaName}</div>,
}));
vi.mock("@/components/AdminPreviewContent", () => ({
  default: (props: { mediaId: string }) => <div data-testid="admin-content">{props.mediaId}</div>,
}));

import MediaLayout from "@/components/layout/MediaLayout";

const baseData: MediaPageData = {
  media: {
    _id: "m1",
    name: "Test Video",
    media_type: "video",
    views_count: 10,
    comments_count: 3,
  },
  channel: { name: "Test Channel", slug: "test-channel" },
  products: [],
  storedProductIds: [],
  previewImages: [],
  thumbSrc: undefined,
  locale: "en",
  instanceConfig: { theme: {}, name: "TestInstance" },
};

describe("MediaLayout", () => {
  it("renders breadcrumb, header, and comment section (one mobile, one desktop)", () => {
    render(<MediaLayout {...baseData} />);
    expect(screen.getByTestId("breadcrumb")).toHaveTextContent("Test Video");
    expect(screen.getByTestId("header")).toHaveTextContent("Test Video");
    // CommentSection now renders twice: once for mobile (in the main column,
    // hidden on lg+) and once for desktop (in the sticky sidebar, hidden
    // below lg). Both wired to the same mediaId.
    const comments = screen.getAllByTestId("comment-section");
    expect(comments.length).toBe(2);
    for (const c of comments) {
      expect(c).toHaveTextContent("m1");
    }
  });

  it("shows UnavailableWall when no products and no admin preview", () => {
    render(<MediaLayout {...baseData} />);
    expect(screen.getByTestId("unavailable-wall")).toHaveTextContent("overlay");
    expect(screen.queryByTestId("payment-wall")).not.toBeInTheDocument();
    expect(screen.queryByTestId("admin-banner")).not.toBeInTheDocument();
  });

  it("shows PaymentWall when products exist", () => {
    const data = {
      ...baseData,
      products: [{ productId: "p1", encryptedBlob: "blob" }],
    };
    render(<MediaLayout {...data} />);
    expect(screen.getByTestId("payment-wall")).toHaveTextContent("m1");
    expect(screen.queryByTestId("unavailable-wall")).not.toBeInTheDocument();
  });

  it("shows admin preview when adminPreviewSourceUrl is set", () => {
    const data = {
      ...baseData,
      adminPreviewSourceUrl: "https://example.com/preview",
      products: [{ productId: "p1", encryptedBlob: "blob" }],
    };
    render(<MediaLayout {...data} />);
    expect(screen.getByTestId("admin-banner")).toHaveTextContent("Test Video");
    expect(screen.getByTestId("admin-content")).toHaveTextContent("m1");
    expect(screen.queryByTestId("payment-wall")).not.toBeInTheDocument();
  });

  it("renders description when present", () => {
    const data = { ...baseData, media: { ...baseData.media, description: "A great video" } };
    render(<MediaLayout {...data} />);
    expect(screen.getByText("A great video")).toBeInTheDocument();
  });

  it("does not render description when absent", () => {
    render(<MediaLayout {...baseData} />);
    expect(screen.queryByText("A great video")).not.toBeInTheDocument();
  });

  it("renders the preview gallery under the content when preview images exist", () => {
    const data = { ...baseData, previewImages: ["/img1.jpg", "/img2.jpg"] };
    render(<MediaLayout {...data} />);
    // The right sidebar is now reserved for the comments column on desktop,
    // so the preview gallery renders once under the main content (visible
    // on all breakpoints), not in two slots.
    const galleries = screen.getAllByTestId("preview-gallery");
    expect(galleries.length).toBe(1);
    expect(galleries[0]).toHaveTextContent("2 images");
  });

  it("does not render preview gallery when no preview images", () => {
    render(<MediaLayout {...baseData} />);
    expect(screen.queryByTestId("preview-gallery")).not.toBeInTheDocument();
  });

  it("uses the wider max-width container (always two-column-capable on desktop)", () => {
    const { container } = render(<MediaLayout {...baseData} />);
    // Sidebar is now universal — always max-w-6xl so the comments column
    // has room to breathe on md+.
    expect(container.firstElementChild?.className).toContain("max-w-6xl");
  });

  it("activates the two-column comments sidebar at md+ (not just lg+)", () => {
    // Intentional regression guard: the previous lg: breakpoint (1024px)
    // dropped the sidebar on the in-app preview pane and tablet widths,
    // making the photo page feel inferior to videos. Sidebar now kicks
    // in at md: (768px).
    const { container } = render(<MediaLayout {...baseData} />);
    const grid = container.querySelector('[class*="md:grid"]');
    expect(grid).not.toBeNull();
    expect(grid?.className).toContain("md:grid");
    expect(grid?.className).toContain("md:grid-cols-[1fr_300px]");
    // …and grows to a wider sidebar on lg+ where there's room.
    expect(grid?.className).toContain("lg:grid-cols-[1fr_360px]");

    // Mobile comments duplicate is hidden at md+, sidebar comments duplicate
    // is hidden below md — exactly one renders at any given breakpoint.
    const mobileWrappers = container.querySelectorAll('[class*="md:hidden"]');
    const sidebarWrappers = container.querySelectorAll('aside[class*="hidden md:block"]');
    expect(mobileWrappers.length).toBeGreaterThan(0);
    expect(sidebarWrappers.length).toBe(1);
  });
});
