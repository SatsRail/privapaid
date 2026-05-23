// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useState } from "react";

// Same MediaForm dependency mocks as ArticleContentField — importing the
// module shouldn't pull in heavy infra.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));
vi.mock("@/lib/fetcher", () => ({ fetcher: vi.fn() }));
vi.mock("@/components/ui/Button", () => ({ default: () => null }));
vi.mock("@/components/ui/Input", () => ({ default: () => null }));
vi.mock("@/components/ui/Select", () => ({ default: () => null }));
vi.mock("@/components/ui/Modal", () => ({ default: () => null }));
vi.mock("@/components/ui/ImageUpload", () => ({ default: () => null }));

import {
  PhotoUploadField,
  PHOTO_MAX_BYTES,
} from "@/app/admin/channels/[id]/media/MediaForm";

interface UploadResult {
  gridFsId: string;
  dek: string;
  mime: string;
  previewUrl: string;
}

function Harness({
  initialGridFsId = null,
  isEditing = false,
}: {
  initialGridFsId?: string | null;
  isEditing?: boolean;
}) {
  const [gridFsId, setGridFsId] = useState<string | null>(initialGridFsId);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dek, setDek] = useState<string | null>(null);

  return (
    <>
      <PhotoUploadField
        gridFsId={gridFsId}
        previewUrl={previewUrl}
        mime={null}
        isEditing={isEditing}
        onUploaded={(payload: UploadResult) => {
          setGridFsId(payload.gridFsId);
          setPreviewUrl(payload.previewUrl);
          setDek(payload.dek);
        }}
      />
      <div data-testid="state">
        {[gridFsId, dek].filter(Boolean).join("|")}
      </div>
    </>
  );
}

function makeFile(name: string, sizeBytes: number, type = "image/jpeg"): File {
  const bytes = new Uint8Array(sizeBytes);
  return new File([bytes], name, { type });
}

describe("PhotoUploadField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock URL.createObjectURL (jsdom doesn't ship one)
    global.URL.createObjectURL = vi.fn().mockReturnValue("blob:fake-preview");
    global.URL.revokeObjectURL = vi.fn();
  });

  it("renders the empty state when no photo is uploaded", () => {
    render(<Harness />);
    expect(screen.getByText(/No photo uploaded yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload photo/i })).toBeInTheDocument();
  });

  it("shows 'Re-upload to replace' for an existing photo without a fresh preview", () => {
    render(<Harness initialGridFsId="abc123" isEditing />);
    expect(screen.getByText(/stored encrypted\. Re-upload to replace/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Replace photo/i })).toBeInTheDocument();
  });

  it("rejects non-image MIME types", async () => {
    const { container } = render(<Harness />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    const bad = new File([new Uint8Array(10)], "doc.pdf", { type: "application/pdf" });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [bad] } });
    });

    expect(screen.getByText(/JPEG, PNG, WebP, or GIF/i)).toBeInTheDocument();
    expect(screen.getByTestId("state")).toHaveTextContent("");
  });

  it("rejects files over PHOTO_MAX_BYTES", async () => {
    const { container } = render(<Harness />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    const oversize = makeFile("big.jpg", PHOTO_MAX_BYTES + 1);
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [oversize] } });
    });

    expect(screen.getByText(/Photo too large/i)).toBeInTheDocument();
    expect(screen.getByTestId("state")).toHaveTextContent("");
  });

  it("POSTs to /api/admin/photos and propagates gridFsId + dek on success", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        gridFsId: "gridfs-id-xyz",
        dek: "base64url-dek-here",
        mime: "image/jpeg",
      }),
    });
    globalThis.fetch = mockFetch;

    const { container } = render(<Harness />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    const file = makeFile("photo.jpg", 1024);
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/admin/photos");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);

    expect(screen.getByTestId("state")).toHaveTextContent("gridfs-id-xyz|base64url-dek-here");
  });

  it("rejects (and revokes) a non-blob: URL from createObjectURL — defense-in-depth against the CodeQL js/xss-through-dom path", async () => {
    // The spec guarantees URL.createObjectURL returns a `blob:` URL, but
    // we assert it anyway: a hypothetical future patch (or a malicious
    // polyfill) that returned, say, `javascript:alert(1)` would otherwise
    // flow into <img src>. CodeQL flags the data path conservatively;
    // this guard narrows the trace AND catches the regression if it ever
    // happens.
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        gridFsId: "gridfs-id-xyz",
        dek: "base64url-dek-here",
        mime: "image/jpeg",
      }),
    });
    globalThis.fetch = mockFetch;

    // Replace the mock to return a non-blob URL.
    const revokeSpy = vi.fn();
    global.URL.createObjectURL = vi.fn().mockReturnValue("javascript:alert(1)");
    global.URL.revokeObjectURL = revokeSpy;

    const { container } = render(<Harness />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = makeFile("photo.jpg", 1024);
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    // Error surfaced to the user; state NOT advanced (no preview to <img>).
    expect(screen.getByText(/Could not generate a safe photo preview/i)).toBeInTheDocument();
    expect(screen.getByTestId("state")).toHaveTextContent("");
    // The bogus URL was revoked so it doesn't linger in memory.
    expect(revokeSpy).toHaveBeenCalledWith("javascript:alert(1)");
  });

  it("surfaces a server error message and leaves state untouched", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Photo upload failed: bad magic bytes" }),
    });
    globalThis.fetch = mockFetch;

    const { container } = render(<Harness />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    const file = makeFile("photo.jpg", 1024);
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    expect(screen.getByText(/Photo upload failed: bad magic bytes/i)).toBeInTheDocument();
    expect(screen.getByTestId("state")).toHaveTextContent("");
  });

  it("warns about ephemeral DEK on new (non-editing) uploads", () => {
    render(<Harness isEditing={false} />);
    expect(
      screen.getByText(/key is lost otherwise/i)
    ).toBeInTheDocument();
  });

  it("omits the ephemeral-DEK warning when editing an existing photo", () => {
    render(<Harness initialGridFsId="abc" isEditing />);
    expect(screen.queryByText(/key is lost otherwise/i)).not.toBeInTheDocument();
  });
});
