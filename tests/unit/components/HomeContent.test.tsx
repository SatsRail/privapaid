// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mockSearchParams = vi.fn(() => ({ get: () => null }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams(),
}));

vi.mock("@/components/CategoryChips", () => ({
  default: ({ categories, onSelect }: { categories: { _id: string; name: string }[]; activeCategory: string | null; onSelect: (id: string | null) => void }) => (
    <div data-testid="category-chips">
      {categories.map((c) => (
        <button key={c._id} onClick={() => onSelect(c._id)}>{c.name}</button>
      ))}
      <button onClick={() => onSelect(null)}>All</button>
    </div>
  ),
}));

vi.mock("@/components/MediaCard", () => ({
  default: ({ media, channelName }: { media: { _id: string; name: string }; channelName?: string }) => (
    <div data-testid={`media-card-${media._id}`}>
      <span>{media.name}</span>
      {channelName && <span>{channelName}</span>}
    </div>
  ),
}));

import HomeContent from "@/components/HomeContent";

const defaultCategories = [
  { _id: "cat1", name: "Music" },
  { _id: "cat2", name: "Art" },
];

const defaultChannels = [
  { _id: "ch1", slug: "music-channel", name: "Music Channel", profile_image_url: "/img.jpg", category_id: "cat1" },
  { _id: "ch2", slug: "art-channel", name: "Art Channel", profile_image_url: "/img2.jpg", category_id: "cat2" },
];

const defaultMediaItems = [
  { _id: "m1", name: "Song 1", description: "A song", media_type: "audio", thumbnail_url: "/t1.jpg", comments_count: 0, channel_id: "ch1" },
  { _id: "m2", name: "Painting 1", description: "A painting", media_type: "photo", thumbnail_url: "/t2.jpg", comments_count: 3, channel_id: "ch2" },
];

describe("HomeContent", () => {
  it("renders media items", () => {
    render(
      <HomeContent
        categories={defaultCategories}
        mediaItems={defaultMediaItems}
        channels={defaultChannels}
        emptyText="No content"
      />
    );
    expect(screen.getByText("Song 1")).toBeInTheDocument();
    expect(screen.getByText("Painting 1")).toBeInTheDocument();
  });

  it("renders category chips when categories exist", () => {
    render(
      <HomeContent
        categories={defaultCategories}
        mediaItems={defaultMediaItems}
        channels={defaultChannels}
        emptyText="No content"
      />
    );
    expect(screen.getByTestId("category-chips")).toBeInTheDocument();
    expect(screen.getByText("Music")).toBeInTheDocument();
    expect(screen.getByText("Art")).toBeInTheDocument();
  });

  it("does not render category chips when no categories", () => {
    render(
      <HomeContent
        categories={[]}
        mediaItems={defaultMediaItems}
        channels={defaultChannels}
        emptyText="No content"
      />
    );
    expect(screen.queryByTestId("category-chips")).not.toBeInTheDocument();
  });

  it("renders empty state when no media items", () => {
    render(
      <HomeContent
        categories={defaultCategories}
        mediaItems={[]}
        channels={defaultChannels}
        emptyText="Nothing here yet"
      />
    );
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("filters media by category when category selected", () => {
    render(
      <HomeContent
        categories={defaultCategories}
        mediaItems={defaultMediaItems}
        channels={defaultChannels}
        emptyText="No content"
      />
    );

    // Click "Music" category
    fireEvent.click(screen.getByText("Music"));

    // Only music channel media should show
    expect(screen.getByText("Song 1")).toBeInTheDocument();
    expect(screen.queryByText("Painting 1")).not.toBeInTheDocument();
  });

  it("shows all media when 'All' selected", () => {
    render(
      <HomeContent
        categories={defaultCategories}
        mediaItems={defaultMediaItems}
        channels={defaultChannels}
        emptyText="No content"
      />
    );

    // Select a category first
    fireEvent.click(screen.getByText("Art"));
    expect(screen.queryByText("Song 1")).not.toBeInTheDocument();

    // Click All
    fireEvent.click(screen.getByText("All"));
    expect(screen.getByText("Song 1")).toBeInTheDocument();
    expect(screen.getByText("Painting 1")).toBeInTheDocument();
  });

  it("shows empty state when filtered category has no media", () => {
    const channels = [
      { _id: "ch1", slug: "music-channel", name: "Music Channel", profile_image_url: "/img.jpg", category_id: "cat1" },
    ];
    const media = [
      { _id: "m1", name: "Song 1", description: "", media_type: "audio", thumbnail_url: "/t1.jpg", comments_count: 0, channel_id: "ch1" },
    ];

    render(
      <HomeContent
        categories={defaultCategories}
        mediaItems={media}
        channels={channels}
        emptyText="No content"
      />
    );

    // Filter by Art which has no channels/media
    fireEvent.click(screen.getByText("Art"));
    expect(screen.getByText("No content")).toBeInTheDocument();
  });

  it("skips media items with unknown channel_id", () => {
    const media = [
      { _id: "m1", name: "Orphan Media", description: "", media_type: "video", thumbnail_url: "/t1.jpg", comments_count: 0, channel_id: "unknown" },
    ];

    render(
      <HomeContent
        categories={[]}
        mediaItems={media}
        channels={defaultChannels}
        emptyText="No content"
      />
    );

    // The media card won't render because channelMap.get returns undefined, and the code returns null
    expect(screen.queryByTestId("media-card-m1")).not.toBeInTheDocument();
  });

  it("reads initial category from search params", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSearchParams.mockReturnValue({ get: ((key: string) => key === "category" ? "cat1" : null) as any });

    render(
      <HomeContent
        categories={defaultCategories}
        mediaItems={defaultMediaItems}
        channels={defaultChannels}
        emptyText="No content"
      />
    );

    // Only music channel media should show (cat1 = Music)
    expect(screen.getByText("Song 1")).toBeInTheDocument();
    expect(screen.queryByText("Painting 1")).not.toBeInTheDocument();

    // Reset mock
    mockSearchParams.mockReturnValue({ get: () => null });
  });
});
