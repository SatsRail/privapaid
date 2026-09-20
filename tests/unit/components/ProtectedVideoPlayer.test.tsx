// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProtectedVideoPlayer from "@/components/ProtectedVideoPlayer";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("ProtectedVideoPlayer", () => {
  it.each([[402, "Check access"], [429, "Retry playback"], [503, "Retry playback"]])("explains playback failure %s", async (status, action) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status }));
    const { container } = render(<ProtectedVideoPlayer mediaId="media-1" />);
    fireEvent.error(container.querySelector("video")!);
    await waitFor(() => expect(screen.getByRole("button", { name: action })).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith("/api/media/media-1/video", expect.objectContaining({ method: "HEAD", cache: "no-store" }));
  });
  it("retries temporary failures without a checkout request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 503 }));
    const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const { container } = render(<ProtectedVideoPlayer mediaId="media-1" />);
    fireEvent.error(container.querySelector("video")!);
    fireEvent.click(await screen.findByText("Retry playback"));
    expect(load).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
