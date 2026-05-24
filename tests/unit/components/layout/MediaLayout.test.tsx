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
vi.mock("@/components/MediaMeta", () => ({
  default: (props: { viewsCount: number }) => <div data-testid="media-meta">{props.viewsCount}</div>,
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
vi.mock("@/components/ChannelSidebar", () => ({
  default: (props: { items: { _id: string }[] }) => (
    <div data-testid="channel-sidebar">{props.items.length} siblings</div>
  ),
}));
vi.mock("@/components/ChannelBlock", () => ({
  default: (props: { name: string }) => <div data-testid="channel-block">{props.name}</div>,
}));
vi.mock("@/components/ActionRow", () => ({
  default: (props: { mediaId: string }) => <div data-testid="action-row">{props.mediaId}</div>,
}));
vi.mock("@/components/ExpandableDescription", () => ({
  default: (props: { text: string }) => <div data-testid="expandable-description">{props.text}</div>,
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
    likes_count: 0,
    shares_count: 0,
  },
  channel: { name: "Test Channel", slug: "test-channel" },
  products: [],
  storedProductIds: [],
  previewImages: [],
  thumbSrc: undefined,
  locale: "en",
  instanceConfig: { theme: {}, name: "TestInstance" },
  siblingMedia: [
    {
      _id: "s1",
      name: "Sibling A",
      thumbnailSrc: "/api/images/a",
      mediaType: "video",
      viewsCount: 100,
      href: "/c/test-channel/s1",
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
    {
      _id: "s2",
      name: "Sibling B",
      thumbnailSrc: "/api/images/b",
      mediaType: "photo",
      viewsCount: 50,
      href: "/c/test-channel/s2",
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
  ],
};

describe("MediaLayout", () => {
  it("renders breadcrumb, header, and comment section ONCE (comments live under content)", () => {
    // After the YouTube-style refactor: comments are no longer duplicated
    // for mobile vs desktop. A single CommentSection sits in the main
    // column, visible on every breakpoint. The right column is now the
    // channel sidebar.
    render(<MediaLayout {...baseData} />);
    expect(screen.getByTestId("breadcrumb")).toHaveTextContent("Test Video");
    expect(screen.getByTestId("header")).toHaveTextContent("Test Video");
    const comments = screen.getAllByTestId("comment-section");
    expect(comments.length).toBe(1);
    expect(comments[0]).toHaveTextContent("m1");
  });

  it("renders the ChannelSidebar in the right column when siblings exist", () => {
    render(<MediaLayout {...baseData} />);
    const sidebar = screen.getByTestId("channel-sidebar");
    expect(sidebar).toHaveTextContent("2 siblings");
  });

  it("collapses to a single column when there are no sibling media (channel-of-one)", () => {
    // Empty sibling list = no rail. Layout becomes single column on every
    // breakpoint — the empty grid track would be uglier than no track.
    const { container } = render(
      <MediaLayout {...baseData} siblingMedia={[]} />
    );
    expect(screen.queryByTestId("channel-sidebar")).not.toBeInTheDocument();
    // No grid classes when there's nothing to fill the second column.
    const grid = container.querySelector('[class*="md:grid"]');
    expect(grid).toBeNull();
  });

  it("uses the YouTube-style grid widths (320px md, 360px lg)", () => {
    const { container } = render(<MediaLayout {...baseData} />);
    const grid = container.querySelector('[class*="md:grid"]');
    expect(grid).not.toBeNull();
    expect(grid?.className).toContain("md:grid-cols-[1fr_320px]");
    expect(grid?.className).toContain("lg:grid-cols-[1fr_360px]");
  });

  it("places the sidebar in an <aside> hidden below md (mobile = no sidebar)", () => {
    const { container } = render(<MediaLayout {...baseData} />);
    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside?.className).toContain("hidden");
    expect(aside?.className).toContain("md:block");
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
    const galleries = screen.getAllByTestId("preview-gallery");
    expect(galleries.length).toBe(1);
    expect(galleries[0]).toHaveTextContent("2 images");
  });

  it("does not render preview gallery when no preview images", () => {
    render(<MediaLayout {...baseData} />);
    expect(screen.queryByTestId("preview-gallery")).not.toBeInTheDocument();
  });

  it("uses the YouTube-scale max-width container (1800px) so a 1280px video + 360px sidebar fit", () => {
    // Raised from max-w-6xl (1024px) to max-w-[1800px] when the left rail
    // got collapsed away. The wider canvas is what makes a 1280px video
    // actually 1280px — without it, the column would be too narrow.
    const { container } = render(<MediaLayout {...baseData} />);
    expect(container.firstElementChild?.className).toContain("max-w-[1800px]");
  });

  it("renders the title (MediaHeader) AFTER the main content block — YouTube reading order", () => {
    // Video-first reading order: the player loads, then the title appears
    // under it, then the meta row. This guards against a future refactor
    // accidentally flipping the order back to title-first.
    const data = {
      ...baseData,
      products: [{ productId: "p1", encryptedBlob: "blob" }],
    };
    const { container } = render(<MediaLayout {...data} />);
    const html = container.innerHTML;
    const headerIdx = html.indexOf('data-testid="header"');
    const mainIdx = html.indexOf('data-testid="payment-wall"');
    expect(headerIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeLessThan(headerIdx);
  });
});
