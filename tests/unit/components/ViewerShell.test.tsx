// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetInstanceConfig = vi.fn();
const mockCategoryFindMany = vi.fn();
const mockChannelFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    category: {
      findMany: (...args: unknown[]) => mockCategoryFindMany(...args),
    },
    channel: {
      findMany: (...args: unknown[]) => mockChannelFindMany(...args),
    },
  },
}));

vi.mock("@/config/instance", () => ({
  getInstanceConfig: () => mockGetInstanceConfig(),
}));

vi.mock("@/components/Sidebar", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="sidebar" data-channels={JSON.stringify(props.channels)} />
  ),
}));

import { render, screen } from "@testing-library/react";
import ViewerShell from "@/components/ViewerShell";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetInstanceConfig.mockResolvedValue({ nsfw: false });

  mockCategoryFindMany.mockResolvedValue([
    { id: "cat1", name: "Music" },
  ]);

  mockChannelFindMany.mockResolvedValue([
    {
      id: "ch1",
      slug: "my-channel",
      name: "My Channel",
      profileImageUrl: "/avatar.jpg",
      profileImageBytes: null,
      mediaCount: 5,
      isLive: false,
      categoryId: "cat1",
    },
    {
      id: "ch2",
      slug: "other",
      name: "Other",
      profileImageUrl: "",
      profileImageBytes: null,
      mediaCount: 0,
      isLive: true,
      categoryId: null,
    },
  ]);
});

describe("ViewerShell", () => {
  it("renders children and sidebar", async () => {
    const el = await ViewerShell({ children: <div data-testid="child">Hello</div> });
    render(el);

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("passes serialized channels to Sidebar", async () => {
    const el = await ViewerShell({ children: <div>OK</div> });
    render(el);

    const sidebar = screen.getByTestId("sidebar");
    const channels = JSON.parse(sidebar.dataset.channels!);
    expect(channels).toHaveLength(2);
    expect(channels[0].slug).toBe("my-channel");
    expect(channels[1].slug).toBe("other");
  });

  it("filters nsfw channels when nsfw is disabled", async () => {
    const el = await ViewerShell({ children: <div>OK</div> });
    render(el);

    expect(mockChannelFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ active: true, nsfw: false }),
      })
    );
  });

  it("does not filter nsfw channels when nsfw is enabled", async () => {
    mockGetInstanceConfig.mockResolvedValue({ nsfw: true });

    const el = await ViewerShell({ children: <div>OK</div> });
    render(el);

    expect(mockChannelFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ nsfw: false }),
      })
    );
  });

  it("groups channels by category and handles uncategorized", async () => {
    const el = await ViewerShell({ children: <div>OK</div> });
    render(el);

    const sidebar = screen.getByTestId("sidebar");
    const channels = JSON.parse(sidebar.dataset.channels!);
    expect(channels).toHaveLength(2);
  });
});
