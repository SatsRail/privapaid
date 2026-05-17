// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock next/link
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// Mock images helper
vi.mock("@/lib/images", () => ({
  resolveImageUrl: (id?: string, url?: string) => id ? `/api/images/${id}` : url || null,
}));

import MediaCard from "@/components/MediaCard";

const defaultMedia = {
  _id: "media-123",
  name: "Test Video",
  description: "A test video",
  media_type: "video",
  thumbnail_url: "https://example.com/thumb.jpg",
  comments_count: 5,
};

describe("MediaCard", () => {
  it("renders media name", () => {
    render(
      <MediaCard
        channelSlug="test-channel"
        channelName="Test Channel"
        media={defaultMedia}
      />
    );
    expect(screen.getByText("Test Video")).toBeInTheDocument();
  });

  it("renders channel name", () => {
    render(
      <MediaCard
        channelSlug="test-channel"
        channelName="Test Channel"
        media={defaultMedia}
      />
    );
    expect(screen.getByText("Test Channel")).toBeInTheDocument();
  });

  it("shows type badge", () => {
    render(
      <MediaCard channelSlug="test-channel" media={defaultMedia} />
    );
    expect(screen.getByText("VIDEO")).toBeInTheDocument();
  });

  it("shows comment count when > 0", () => {
    render(
      <MediaCard channelSlug="test-channel" media={defaultMedia} />
    );
    expect(screen.getByText("5 comments")).toBeInTheDocument();
  });

  it("shows singular comment for count of 1", () => {
    render(
      <MediaCard
        channelSlug="test-channel"
        media={{ ...defaultMedia, comments_count: 1 }}
      />
    );
    expect(screen.getByText("1 comment")).toBeInTheDocument();
  });

  it("does not show comment count when 0", () => {
    render(
      <MediaCard
        channelSlug="test-channel"
        media={{ ...defaultMedia, comments_count: 0 }}
      />
    );
    expect(screen.queryByText(/comment/)).not.toBeInTheDocument();
  });

  it("links to media page", () => {
    render(
      <MediaCard channelSlug="test-channel" media={defaultMedia} />
    );
    const links = screen.getAllByRole("link");
    const mediaLink = links.find((l) => l.getAttribute("href")?.includes("/media-123"));
    expect(mediaLink).toBeTruthy();
  });

  it("shows channel initial when no avatar", () => {
    render(
      <MediaCard
        channelSlug="test-channel"
        channelName="Test Channel"
        media={defaultMedia}
      />
    );
    expect(screen.getByText("T")).toBeInTheDocument();
  });

  it("renders different media types", () => {
    const audioMedia = { ...defaultMedia, media_type: "audio" };
    render(
      <MediaCard channelSlug="test-channel" media={audioMedia} />
    );
    expect(screen.getByText("AUDIO")).toBeInTheDocument();
  });

  // --- Branch coverage additions ---

  it("renders price badge when price is provided", () => {
    render(
      <MediaCard
        channelSlug="test-channel"
        media={defaultMedia}
        price={{ cents: 999, currency: "USD" }}
      />
    );
    expect(screen.getByText("$9.99")).toBeInTheDocument();
  });

  it("formats price without decimals when cents are whole dollars", () => {
    render(
      <MediaCard
        channelSlug="test-channel"
        media={defaultMedia}
        price={{ cents: 500, currency: "USD" }}
      />
    );
    expect(screen.getByText("$5")).toBeInTheDocument();
  });

  it("does not render price badge when price is not provided", () => {
    const { container } = render(
      <MediaCard channelSlug="test-channel" media={defaultMedia} />
    );
    // No price badge element with the specific class
    const priceBadges = container.querySelectorAll("[class*='left-1.5']");
    // The price badge has left-1.5 positioning; it shouldn't exist
    const priceSpans = Array.from(container.querySelectorAll("span")).filter(
      (el) => el.className.includes("left-1.5")
    );
    expect(priceSpans.length).toBe(0);
  });

  it("renders thumbnail image when thumbnail_url resolves", () => {
    render(
      <MediaCard channelSlug="test-channel" media={defaultMedia} />
    );
    const img = document.querySelector(`img[alt="Test Video"]`);
    expect(img).not.toBeNull();
  });

  it("renders placeholder icon when no thumbnail", () => {
    const noThumbMedia = { ...defaultMedia, thumbnail_url: "", thumbnail_id: undefined };
    render(
      <MediaCard channelSlug="test-channel" media={noThumbMedia} />
    );
    // No img for the thumbnail, but a placeholder icon div should exist
    const img = document.querySelector(`img[alt="Test Video"]`);
    expect(img).toBeNull();
  });

  it("renders channel avatar image when channelAvatarId provided", () => {
    render(
      <MediaCard
        channelSlug="test-channel"
        channelName="Test Channel"
        channelAvatarId="avatar-123"
        media={defaultMedia}
      />
    );
    const img = document.querySelector(`img[alt="Test Channel"]`);
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/api/images/avatar-123");
  });

  it("renders channel avatar image when channelAvatarUrl provided", () => {
    render(
      <MediaCard
        channelSlug="test-channel"
        channelName="Test Channel"
        channelAvatarUrl="https://example.com/avatar.jpg"
        media={defaultMedia}
      />
    );
    const img = document.querySelector(`img[alt="Test Channel"]`);
    expect(img).not.toBeNull();
  });

  it("does not render channel section when channelName not provided", () => {
    render(
      <MediaCard channelSlug="test-channel" media={defaultMedia} />
    );
    // No channel avatar or channel name link
    expect(screen.queryByText("T")).not.toBeInTheDocument();
  });

  it("renders views count when > 0", () => {
    const mediaWithViews = { ...defaultMedia, views_count: 42 };
    render(
      <MediaCard channelSlug="test-channel" media={mediaWithViews} />
    );
    expect(screen.getByText("42 views")).toBeInTheDocument();
  });

  it("renders singular view for count of 1", () => {
    const mediaWithViews = { ...defaultMedia, views_count: 1 };
    render(
      <MediaCard channelSlug="test-channel" media={mediaWithViews} />
    );
    expect(screen.getByText("1 view")).toBeInTheDocument();
  });

  it("does not render views when views_count is 0", () => {
    const mediaWithViews = { ...defaultMedia, views_count: 0 };
    render(
      <MediaCard channelSlug="test-channel" media={mediaWithViews} />
    );
    expect(screen.queryByText(/view/)).not.toBeInTheDocument();
  });

  it("does not render views when views_count is null/undefined", () => {
    render(
      <MediaCard channelSlug="test-channel" media={defaultMedia} />
    );
    expect(screen.queryByText(/view/)).not.toBeInTheDocument();
  });

  it("falls back to media_type uppercase for unknown type labels", () => {
    const customMedia = { ...defaultMedia, media_type: "livestream" };
    render(
      <MediaCard channelSlug="test-channel" media={customMedia} />
    );
    expect(screen.getByText("LIVESTREAM")).toBeInTheDocument();
  });

  it("renders article type badge", () => {
    const articleMedia = { ...defaultMedia, media_type: "article" };
    render(
      <MediaCard channelSlug="test-channel" media={articleMedia} />
    );
    expect(screen.getByText("ARTICLE")).toBeInTheDocument();
  });

  it("renders photo type badge", () => {
    const photoMedia = { ...defaultMedia, media_type: "photo" };
    render(
      <MediaCard channelSlug="test-channel" media={photoMedia} />
    );
    expect(screen.getByText("PHOTO")).toBeInTheDocument();
  });

  it("renders podcast type badge", () => {
    const podMedia = { ...defaultMedia, media_type: "podcast" };
    render(
      <MediaCard channelSlug="test-channel" media={podMedia} />
    );
    expect(screen.getByText("PODCAST")).toBeInTheDocument();
  });

  it("renders thumbnail via thumbnail_id when provided", () => {
    const mediaWithThumbId = { ...defaultMedia, thumbnail_id: "thumb-456" };
    render(
      <MediaCard channelSlug="test-channel" media={mediaWithThumbId} />
    );
    const img = document.querySelector(`img[alt="Test Video"]`);
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/api/images/thumb-456");
  });
});
