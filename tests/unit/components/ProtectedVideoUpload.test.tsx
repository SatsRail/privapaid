// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProtectedVideoUpload from "@/components/ProtectedVideoUpload";

let xhr: FakeXHR;
class FakeXHR {
  upload: { onprogress?: (event: { loaded: number; total: number; lengthComputable: boolean }) => void } = {};
  open = vi.fn(); setRequestHeader = vi.fn(); send = vi.fn();
  abort = vi.fn(() => this.onabort?.());
  status = 201; responseText = ""; timeout = 0;
  onload?: () => void; onerror?: () => void; onabort?: () => void; ontimeout?: () => void;
  // Capture the browser-created request so tests can deliver progress/response events.
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  constructor() { xhr = this; }
}
beforeEach(() => vi.stubGlobal("XMLHttpRequest", FakeXHR));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reference = "https://protected-video.invalid/12345678-1234-1234-1234-123456789abc.mp4";
function select() {
  const file = new File(["test video"], "video.mp4", { type: "video/mp4" });
  fireEvent.change(screen.getByLabelText("Upload protected video"), { target: { files: [file] } });
  return file;
}
describe("ProtectedVideoUpload", () => {
  it("shows real upload progress and waits for validation before changing the source", async () => {
    const uploaded = vi.fn(), busy = vi.fn();
    render(<ProtectedVideoUpload source="" onUploaded={uploaded} onBusy={busy} />);
    const file = select();
    expect(xhr.send).toHaveBeenCalledWith(file);
    expect(xhr.open).toHaveBeenCalledWith("POST", "/api/admin/videos");
    act(() => xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "50");
    expect(uploaded).not.toHaveBeenCalled();
    act(() => { xhr.responseText = JSON.stringify({ source_url: reference }); xhr.onload?.(); });
    await waitFor(() => expect(uploaded).toHaveBeenCalledWith(reference));
    expect(busy.mock.calls).toEqual([[true], [false]]);
  });
  it("cancels without changing the saved source and permits another selection", async () => {
    const uploaded = vi.fn(), busy = vi.fn();
    render(<ProtectedVideoUpload source={reference} onUploaded={uploaded} onBusy={busy} />);
    select(); fireEvent.click(screen.getByText("Cancel upload"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("cancelled"));
    expect(uploaded).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Upload protected video")).not.toBeDisabled();
    expect(busy).toHaveBeenLastCalledWith(false);
  });
  it("surfaces server validation errors and clears busy state", async () => {
    const uploaded = vi.fn(), busy = vi.fn();
    render(<ProtectedVideoUpload source={reference} onUploaded={uploaded} onBusy={busy} />);
    select();
    act(() => { xhr.status = 422; xhr.responseText = JSON.stringify({ error: "Unsupported codec" }); xhr.onload?.(); });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Unsupported codec"));
    expect(uploaded).not.toHaveBeenCalled(); expect(busy).toHaveBeenLastCalledWith(false);
  });
});
