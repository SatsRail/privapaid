// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

vi.mock("@/i18n/useLocale", () => ({
  useLocale: () => ({
    t: (key: string) => key,
    locale: "en",
  }),
}));

import ActionRow from "@/components/ActionRow";

// Default props for ActionRow — covers the new required count props.
const baseProps = {
  mediaId: "m1",
  mediaName: "Test",
  initialLikesCount: 0,
  initialSharesCount: 0,
  // Default: viewer has paid access. Tests that exercise the locked
  // state pass `hasAccess={false}` explicitly.
  hasAccess: true,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((k: string) => store[k] ?? null),
    setItem: vi.fn((k: string, v: string) => { store[k] = v; }),
    removeItem: vi.fn((k: string) => { delete store[k]; }),
  });
  // navigator.clipboard is jsdom-stubbed; provide a writeText that returns a promise.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
  // Default: no native share API. Tests that want it set it manually.
  delete (navigator as { share?: unknown }).share;

  // Default fetch mock — successful response, ok=true. Tests can override.
  fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const isLike = typeof url === "string" && url.includes("/like");
    const body = init?.body
      ? (JSON.parse(String(init.body)) as { action?: string })
      : null;
    if (isLike) {
      const next = body?.action === "like" ? 1 : 0;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ likes_count: next }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ shares_count: 1 }),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("ActionRow", () => {
  it("renders Like / Share buttons", () => {
    render(<ActionRow {...baseProps} />);
    expect(screen.getByTestId("like-button")).toBeInTheDocument();
    expect(screen.getByTestId("share-button")).toBeInTheDocument();
  });

  it("renders initial like/share counts when greater than 0", () => {
    render(<ActionRow {...baseProps} initialLikesCount={42} initialSharesCount={7} />);
    expect(screen.getByTestId("likes-count")).toHaveTextContent("42");
    expect(screen.getByTestId("shares-count")).toHaveTextContent("7");
  });

  it("disables Like + Dislike when hasAccess is false", () => {
    render(<ActionRow {...baseProps} hasAccess={false} />);
    expect(screen.getByTestId("like-button")).toBeDisabled();
    expect(screen.getByTestId("dislike-button")).toBeDisabled();
    // Share stays enabled — it is not payment-gated.
    expect(screen.getByTestId("share-button")).not.toBeDisabled();
  });

  it("does not fire the like API when hasAccess is false", async () => {
    render(<ActionRow {...baseProps} hasAccess={false} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("like-button"));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // aria-pressed stays false — the optimistic flip never happened.
    expect(screen.getByTestId("like-button")).toHaveAttribute("aria-pressed", "false");
  });

  it("does not toggle Dislike state when hasAccess is false", () => {
    render(<ActionRow {...baseProps} hasAccess={false} />);
    fireEvent.click(screen.getByTestId("dislike-button"));
    expect(screen.getByTestId("dislike-button")).toHaveAttribute("aria-pressed", "false");
  });

  it("Share still works even when hasAccess is false", async () => {
    Object.defineProperty(window, "location", {
      value: { href: "https://example.com/c/ch/m1" },
      writable: true,
    });
    render(<ActionRow {...baseProps} hasAccess={false} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-button"));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://example.com/c/ch/m1");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/media/m1/share",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("hides zero counts so brand-new media doesn't show 'Like 0'", () => {
    render(<ActionRow {...baseProps} />);
    expect(screen.queryByTestId("likes-count")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shares-count")).not.toBeInTheDocument();
  });

  it("toggles Like state on click + persists to localStorage", async () => {
    render(<ActionRow {...baseProps} />);
    const btn = screen.getByTestId("like-button");
    expect(btn).toHaveAttribute("aria-pressed", "false");

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.setItem).toHaveBeenCalledWith("privapaid:liked:m1", "true");

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.removeItem).toHaveBeenCalledWith("privapaid:liked:m1");
  });

  it("POSTs action:like on first click and action:unlike on second", async () => {
    render(<ActionRow {...baseProps} />);
    const btn = screen.getByTestId("like-button");

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/media/m1/like",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "like" }),
      })
    );

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/media/m1/like",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "unlike" }),
      })
    );
  });

  it("optimistically updates the like count and reconciles with the server", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ likes_count: 11 }),
    });
    render(<ActionRow {...baseProps} initialLikesCount={10} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("like-button"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("likes-count")).toHaveTextContent("11");
    });
  });

  it("reverts the like count + pressed state when the server rejects", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "boom" }),
    });
    render(<ActionRow {...baseProps} initialLikesCount={5} />);

    const btn = screen.getByTestId("like-button");
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(btn).toHaveAttribute("aria-pressed", "false");
    });
    expect(screen.getByTestId("likes-count")).toHaveTextContent("5");
  });

  it("renders a Dislike button alongside Like (YouTube split pill)", () => {
    render(<ActionRow {...baseProps} />);
    expect(screen.getByTestId("dislike-button")).toBeInTheDocument();
  });

  it("dislike does not hit the server (local-only)", () => {
    render(<ActionRow {...baseProps} />);
    fireEvent.click(screen.getByTestId("dislike-button"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clicking Dislike clears Like (mutually exclusive — matches YouTube)", async () => {
    render(<ActionRow {...baseProps} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("like-button"));
    });
    expect(screen.getByTestId("like-button")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("dislike-button"));
    expect(screen.getByTestId("dislike-button")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("like-button")).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking Like clears a prior Dislike (the reverse case)", async () => {
    render(<ActionRow {...baseProps} />);
    fireEvent.click(screen.getByTestId("dislike-button"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("like-button"));
    });
    expect(screen.getByTestId("like-button")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("dislike-button")).toHaveAttribute("aria-pressed", "false");
  });

  it("share copies the current URL to clipboard, fires POST, and bumps count", async () => {
    Object.defineProperty(window, "location", {
      value: { href: "https://example.com/c/ch/m1" },
      writable: true,
    });
    render(<ActionRow {...baseProps} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("share-button"));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://example.com/c/ch/m1");
    await waitFor(() => {
      expect(screen.getByText("viewer.actions.copied")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/media/m1/share",
        expect.objectContaining({ method: "POST" })
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("shares-count")).toHaveTextContent("1");
    });
  });

  it("does not reconcile like count when response omits likes_count", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    render(<ActionRow {...baseProps} initialLikesCount={5} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("like-button"));
    });

    await waitFor(() => {
      // Optimistic +1 stays — no server value to overwrite with.
      expect(screen.getByTestId("likes-count")).toHaveTextContent("6");
    });
  });

  it("does not reconcile share count when fetch returns non-OK", async () => {
    Object.defineProperty(window, "location", {
      value: { href: "https://example.com/c/ch/m1" },
      writable: true,
    });
    // Override the share POST specifically — clipboard write stays ok, share POST returns 500.
    fetchMock.mockImplementationOnce((url: string) => {
      if (url.includes("/share")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: "boom" }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    render(<ActionRow {...baseProps} initialSharesCount={2} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("share-button"));
    });

    await waitFor(() => {
      // Optimistic +1 stays even when telemetry POST fails.
      expect(screen.getByTestId("shares-count")).toHaveTextContent("3");
    });
  });

  it("does not reconcile share count when response omits shares_count", async () => {
    Object.defineProperty(window, "location", {
      value: { href: "https://example.com/c/ch/m1" },
      writable: true,
    });
    fetchMock.mockImplementationOnce((url: string) => {
      if (url.includes("/share")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    render(<ActionRow {...baseProps} initialSharesCount={4} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("share-button"));
    });

    await waitFor(() => {
      // Optimistic +1 holds — nothing to reconcile to.
      expect(screen.getByTestId("shares-count")).toHaveTextContent("5");
    });
  });

  it("restores prior Dislike when the like POST is rejected by the server", async () => {
    // Hydrate with both a previous "disliked" state and an explicitly-zero like count.
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation(
      (k: string) => (k === "privapaid:disliked:m1" ? "true" : null)
    );
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "boom" }),
    });
    render(<ActionRow {...baseProps} />);
    // Wait for hydration.
    await waitFor(() => {
      expect(screen.getByTestId("dislike-button")).toHaveAttribute("aria-pressed", "true");
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("like-button"));
    });

    await waitFor(() => {
      // Like reverted.
      expect(screen.getByTestId("like-button")).toHaveAttribute("aria-pressed", "false");
      // And the prior dislike is restored.
      expect(screen.getByTestId("dislike-button")).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("falls back to clipboard when navigator.share rejects (user cancels native sheet)", async () => {
    const shareSpy = vi.fn().mockRejectedValue(new Error("AbortError"));
    Object.defineProperty(navigator, "share", { value: shareSpy, configurable: true });
    Object.defineProperty(window, "location", {
      value: { href: "https://example.com/c/ch/m1" },
      writable: true,
    });

    render(<ActionRow {...baseProps} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("share-button"));
    });

    expect(shareSpy).toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://example.com/c/ch/m1");
  });

  it("shows the copy_failed toast when clipboard write rejects", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    Object.defineProperty(window, "location", {
      value: { href: "https://example.com/c/ch/m1" },
      writable: true,
    });

    render(<ActionRow {...baseProps} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("share-button"));
    });

    await waitFor(() => {
      expect(screen.getByText("viewer.actions.copy_failed")).toBeInTheDocument();
    });
  });

  it("prefers the native Share API when available + still posts the share count", async () => {
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      value: shareSpy,
      configurable: true,
    });
    Object.defineProperty(window, "location", {
      value: { href: "https://example.com/c/ch/m2" },
      writable: true,
    });

    render(<ActionRow {...baseProps} mediaId="m2" mediaName="Mobile Share" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-button"));
    });
    expect(shareSpy).toHaveBeenCalledWith({
      title: "Mobile Share",
      url: "https://example.com/c/ch/m2",
    });
    // Clipboard NOT used when native share succeeded.
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    // Telemetry still fires.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/media/m2/share",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("hydrates Liked from localStorage on mount", async () => {
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation(
      (k: string) => k.startsWith("privapaid:liked:") ? "true" : null
    );
    render(<ActionRow {...baseProps} mediaId="hydrated" />);
    await Promise.resolve();
    expect(screen.getByTestId("like-button")).toHaveAttribute("aria-pressed", "true");
  });
});
