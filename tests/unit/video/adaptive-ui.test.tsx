// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import VideoCapacity from "@/components/VideoCapacity";
import VideoLibrary from "@/app/admin/videos/VideoLibrary";
import SegmentedVideoPlayer from "@/components/SegmentedVideoPlayer";
const mock = vi.hoisted(() => ({ request: vi.fn(), quality: vi.fn(), destroy: vi.fn(async () => {}), create: vi.fn() }));
vi.mock("@/lib/video/upload-client", () => ({ uploadRequest: mock.request }));
vi.mock("@/lib/video/browser-player", () => ({ createVideoPlayer: mock.create }));
vi.mock("@/i18n/useLocale", () => ({ useLocale: () => ({ t: (key: string) => key.split(".").at(-1) }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const capacity = { readiness: { ready: true, workerCount: 2 }, processing: 1, queued: 2, pending: 3, maxPending: 4, encryptedOutputBytes: "1073741824", reservedBytes: "2147483648", storageBudgetBytes: "107374182400" };
it("reports capacity and distinguishes reserved space from prepared output", async () => {
  mock.request.mockResolvedValue(capacity); render(<VideoCapacity />);
  expect(await screen.findByText(/Ready to prepare videos · 2 worker/)).toBeInTheDocument();
  expect(screen.getByText(/1 processing · 2 queued · 3\/4/)).toBeInTheDocument();
  expect(screen.getByText(/1.00 GiB of prepared output · 2.00\/100.00 GiB reserved/)).toBeInTheDocument();
  expect(screen.getByText(/not the total storage bill/)).toBeInTheDocument();
});
it("pages and searches the owner library with bounded requests", async () => {
  mock.request.mockImplementation(async (url: string) => url === "/capacity" ? capacity : url.includes("cursor=") || url.includes("q=missing") ? { items: [], cursor: null } : { items: [{ id: "a", mediaId: "m", media: { channelId: "c", name: "Movie" }, versions: [{ id: "next", status: "processing", progress: 40 }], publishedVersion: { id: "old" } }], cursor: "next-page" });
  render(<VideoLibrary />);
  expect(await screen.findByRole("link", { name: "Movie" })).toHaveAttribute("href", "/admin/channels/c/media/m/video");
  expect(screen.getByText(/previous version retained during preparation/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(await screen.findByText("No videos found.")).toBeInTheDocument();
  expect(mock.request).toHaveBeenCalledWith("/assets?limit=25&q=&cursor=next-page", expect.anything());
  fireEvent.change(screen.getByLabelText("Find a video"), { target: { value: "missing" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() => expect(mock.request).toHaveBeenCalledWith("/assets?limit=25&q=missing", expect.anything()));
  expect(screen.getByRole("button", { name: "First page" })).toBeDisabled();
});
it("exposes a labelled Auto/manual selector and cleans up the existing player", async () => {
  mock.create.mockImplementation((_video, _id, state, _initial, _resume, quality) => {
    state("ready"); quality({ automatic: true, activeId: 1, options: [{ id: 1, height: 360, width: 640, bandwidth: 500000 }, { id: 2, height: 720, width: 1280, bandwidth: 1800000 }] });
    return { ready: Promise.resolve(), handle: { quality: mock.quality, destroy: mock.destroy } };
  });
  const { container, unmount } = render(<SegmentedVideoPlayer mediaId="movie" />);
  const select = await screen.findByLabelText("quality");
  expect(select).toHaveValue("auto");
  fireEvent.change(select, { target: { value: "2" } }); expect(mock.quality).toHaveBeenCalledWith(2);
  fireEvent.change(select, { target: { value: "auto" } }); expect(mock.quality).toHaveBeenCalledWith("auto");
  expect(container.querySelectorAll("video")).toHaveLength(1);
  unmount(); expect(mock.destroy).toHaveBeenCalledOnce();
});
it("shows an unsupported browser state without a quality selector", async () => {
  mock.create.mockImplementation((_video, _id, state) => { state("unsupported"); return { ready: Promise.resolve(), handle: { destroy: mock.destroy } }; });
  render(<SegmentedVideoPlayer mediaId="movie" />);
  expect(await screen.findByRole("status")).toHaveTextContent("unsupported");
  expect(screen.queryByRole("combobox")).toBeNull();
});
