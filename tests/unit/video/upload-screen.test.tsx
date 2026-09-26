// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import VideoUpload from "@/app/admin/channels/[id]/media/[mediaId]/video/VideoUpload";
const client = vi.hoisted(() => ({ request: vi.fn(), transfer: vi.fn() }));
vi.mock("@/components/VideoCapacity", () => ({ default: () => null, gib: (v: number) => (v / 1024 ** 3).toFixed(2) }));
vi.mock("@/lib/video/file-info", () => ({ localVideoInfo: async () => ({ duration: 7200, width: 1280, height: 720 }) }));
vi.mock("@/lib/video/upload-client", () => ({ uploadRequest: client.request, transferFile: client.transfer, fileFingerprint: async () => "a".repeat(64) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const current = { id: "saved", status: "uploading", receivedBytes: 8388608, bytes: 16777216, partBytes: 8388608, progress: 0, error: null, expiresAt: "2026-10-01T00:00:00Z" };
it("restores an upload after reload and resumes with the reselected file", async () => {
  client.request.mockResolvedValueOnce({ items: [current] }).mockResolvedValueOnce(current);
  client.transfer.mockResolvedValue({ ...current, status: "ready", progress: 100 });
  render(<VideoUpload mediaId="movie" products={[{ id: "product", name: "Movie access" }]} />);
  expect(await screen.findByText(/Reselect the original file/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("MP4 file"), { target: { files: [new File(["123456789012"], "movie.mp4")] } });
  fireEvent.click(screen.getByRole("button", { name: "Resume upload" }));
  expect(await screen.findByText("Video prepared successfully")).toBeInTheDocument();
  expect(client.request.mock.calls[1][0]).toBe("/uploads/saved/resume");
  expect(client.transfer.mock.calls[0][1].receivedBytes).toBe(8388608);
});
it("shows processing errors and retries the retained job", async () => {
  client.request.mockResolvedValueOnce({ items: [{ ...current, status: "failed", canRetry: true, error: "KEY_STATE_CHANGED" }] })
    .mockRejectedValueOnce(new Error("Finish product-key rotation, then resume this upload."));
  render(<VideoUpload mediaId="movie" products={[{ id: "product", name: "Movie access" }]} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry processing" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Finish product-key rotation"));
  expect(client.request.mock.calls[1][0]).toBe("/uploads/saved/retry");
});
it("cancels the saved session and blocks new uploads without an associated product", async () => {
  client.request.mockResolvedValueOnce({ items: [current] }).mockResolvedValueOnce({ ...current, status: "cancelled" });
  render(<VideoUpload mediaId="movie" products={[]} />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel upload" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Upload and prepare" })).toBeDisabled());
  expect(client.request.mock.calls[1]).toEqual(["/uploads/saved", expect.objectContaining({ method: "DELETE" })]);
});
it("explains both segment presets and updates movie estimates before upload", async () => {
  client.request.mockResolvedValue({ items: [] });
  render(<VideoUpload mediaId="movie" products={[{ id: "product", name: "Movie access" }]} />);
  await waitFor(() => expect(screen.getByLabelText("MP4 file")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("MP4 file"), { target: { files: [new File(["movie source"], "movie.mp4")] } });
  expect(await screen.findByText(/3,604 media requests/)).toBeInTheDocument();
  expect(screen.getByText(/640×360, 852×480, 1280×720/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Playback segment duration"), { target: { value: "10" } });
  expect(screen.getByText(/1,444 media requests/)).toBeInTheDocument();
  expect(screen.getByText(/does not change SatsRail renewal calls/)).toBeInTheDocument();
});
