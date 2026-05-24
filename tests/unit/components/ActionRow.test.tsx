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
});

describe("ActionRow", () => {
  it("renders Like / Share / Save buttons", () => {
    render(<ActionRow mediaId="m1" mediaName="Test" />);
    expect(screen.getByTestId("like-button")).toBeInTheDocument();
    expect(screen.getByTestId("share-button")).toBeInTheDocument();
    expect(screen.getByTestId("save-button")).toBeInTheDocument();
  });

  it("toggles Like state on click + persists to localStorage", () => {
    render(<ActionRow mediaId="m1" mediaName="Test" />);
    const btn = screen.getByTestId("like-button");
    expect(btn).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.setItem).toHaveBeenCalledWith("privapaid:liked:m1", "true");

    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.removeItem).toHaveBeenCalledWith("privapaid:liked:m1");
  });

  it("toggles Save state independently of Like", () => {
    render(<ActionRow mediaId="m1" mediaName="Test" />);
    fireEvent.click(screen.getByTestId("save-button"));
    expect(screen.getByTestId("save-button")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("like-button")).toHaveAttribute("aria-pressed", "false");
  });

  it("share copies the current URL to clipboard and shows a toast", async () => {
    // jsdom defaults to "about:blank"; override.
    Object.defineProperty(window, "location", {
      value: { href: "https://example.com/c/ch/m1" },
      writable: true,
    });
    render(<ActionRow mediaId="m1" mediaName="Test" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("share-button"));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://example.com/c/ch/m1");
    await waitFor(() => {
      expect(screen.getByText("viewer.actions.copied")).toBeInTheDocument();
    });
  });

  it("prefers the native Share API when available", async () => {
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      value: shareSpy,
      configurable: true,
    });
    Object.defineProperty(window, "location", {
      value: { href: "https://example.com/c/ch/m2" },
      writable: true,
    });

    render(<ActionRow mediaId="m2" mediaName="Mobile Share" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-button"));
    });
    expect(shareSpy).toHaveBeenCalledWith({
      title: "Mobile Share",
      url: "https://example.com/c/ch/m2",
    });
    // Clipboard NOT used when native share succeeded.
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("hydrates Liked + Saved from localStorage on mount", async () => {
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation(
      (k: string) => (k.startsWith("privapaid:liked:") || k.startsWith("privapaid:saved:")) ? "true" : null
    );
    render(<ActionRow mediaId="hydrated" mediaName="Test" />);
    await Promise.resolve();
    expect(screen.getByTestId("like-button")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("save-button")).toHaveAttribute("aria-pressed", "true");
  });
});
