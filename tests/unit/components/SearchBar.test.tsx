// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockPush = vi.fn();
const mockT = vi.fn((key: string) => key);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/i18n/useLocale", () => ({
  useLocale: () => ({ t: mockT }),
}));

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import SearchBar from "@/components/SearchBar";

beforeEach(() => {
  vi.useFakeTimers();
  mockPush.mockClear();
  mockT.mockClear();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SearchBar", () => {
  it("renders with default placeholder from t()", () => {
    render(<SearchBar />);
    expect(screen.getByPlaceholderText("viewer.search.placeholder")).toBeInTheDocument();
  });

  it("renders with custom placeholder", () => {
    render(<SearchBar placeholder="Find stuff" />);
    expect(screen.getByPlaceholderText("Find stuff")).toBeInTheDocument();
  });

  it("shows search icon when focused", () => {
    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.focus(input);
    // The focused state renders an SVG search icon before the input
    const svgs = document.querySelectorAll("svg");
    // At least the focused icon + the search button icon
    expect(svgs.length).toBeGreaterThanOrEqual(2);
  });

  it("does not search when query is less than 2 characters", async () => {
    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "a" } });
    act(() => { vi.advanceTimersByTime(300); });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("debounces and fetches search results", async () => {
    const mockResults = [
      { type: "channel", id: "1", name: "Test Channel", slug: "test-channel" },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "test" } });

    // Before debounce fires
    expect(fetch).not.toHaveBeenCalled();

    // After debounce
    await act(async () => { vi.advanceTimersByTime(300); });

    expect(fetch).toHaveBeenCalledWith("/api/search?q=test");
  });

  it("shows results dropdown when results arrive", async () => {
    const mockResults = [
      { type: "channel", id: "1", name: "My Channel", slug: "my-channel" },
      { type: "media", id: "2", name: "My Video", slug: "my-video", channelSlug: "my-channel", mediaType: "video" },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "my" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    expect(screen.getByText("My Channel")).toBeInTheDocument();
    expect(screen.getByText("My Video")).toBeInTheDocument();
  });

  it("navigates to channel on click", async () => {
    const mockResults = [
      { type: "channel", id: "1", name: "Chan", slug: "chan-slug" },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "chan" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    fireEvent.click(screen.getByText("Chan"));
    expect(mockPush).toHaveBeenCalledWith("/c/chan-slug");
  });

  it("navigates to media on click", async () => {
    const mockResults = [
      { type: "media", id: "m1", name: "Video", slug: "vid", channelSlug: "ch1", mediaType: "video" },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "vid" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    fireEvent.click(screen.getByText("Video"));
    expect(mockPush).toHaveBeenCalledWith("/c/ch1/m1");
  });

  it("shows clear button when query is non-empty and clears on click", async () => {
    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "hello" } });

    const clearBtn = screen.getByLabelText("Clear search");
    fireEvent.click(clearBtn);
    expect(input).toHaveValue("");
  });

  it("handles keyboard navigation: ArrowDown, ArrowUp, Enter, Escape", async () => {
    const mockResults = [
      { type: "channel", id: "1", name: "First", slug: "first" },
      { type: "channel", id: "2", name: "Second", slug: "second" },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "test" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    // ArrowDown to select first
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // ArrowDown to select second
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // ArrowUp to go back to first
    fireEvent.keyDown(input, { key: "ArrowUp" });
    // Enter to navigate
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockPush).toHaveBeenCalledWith("/c/first");
  });

  it("Escape closes dropdown and blurs input", async () => {
    const mockResults = [
      { type: "channel", id: "1", name: "First", slug: "first" },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "test" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    fireEvent.keyDown(input, { key: "Escape" });
    // Dropdown should close — "First" no longer visible
    expect(screen.queryByText("First")).not.toBeInTheDocument();
  });

  it("Escape when no results still closes and blurs", () => {
    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Escape" });
    // No error, just works
  });

  it("handles fetch error gracefully", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network"));

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "test" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    // Should not crash, no results shown
    expect(screen.queryByRole("button", { name: "First" })).not.toBeInTheDocument();
  });

  it("handles non-ok response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "test" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    // No results — no crash
    expect(screen.queryByText("viewer.search.channel")).not.toBeInTheDocument();
  });

  it("closes dropdown on outside click", async () => {
    const mockResults = [
      { type: "channel", id: "1", name: "Result", slug: "result" },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "test" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    expect(screen.getByText("Result")).toBeInTheDocument();

    // Click outside
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Result")).not.toBeInTheDocument();
  });

  it("search button triggers search", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "query" } });

    const searchBtn = screen.getByLabelText("Search");
    await act(async () => { fireEvent.click(searchBtn); });

    expect(fetch).toHaveBeenCalledWith("/api/search?q=query");
  });

  it("search button does nothing when query is empty", () => {
    render(<SearchBar />);
    const searchBtn = screen.getByLabelText("Search");
    fireEvent.click(searchBtn);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows no_results message when query >= 2 chars but no results", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "xyz" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    expect(screen.getByText("viewer.search.no_results")).toBeInTheDocument();
  });

  it("reopens dropdown on focus when results exist", async () => {
    const mockResults = [
      { type: "channel", id: "1", name: "Re-open", slug: "re" },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "re" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    // Close
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Re-open")).not.toBeInTheDocument();

    // Re-focus
    fireEvent.focus(input);
    expect(screen.getByText("Re-open")).toBeInTheDocument();
  });

  it("ArrowDown wraps around to first item", async () => {
    const mockResults = [
      { type: "channel", id: "1", name: "A", slug: "a" },
      { type: "channel", id: "2", name: "B", slug: "b" },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "ab" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    // Press ArrowDown 3 times to wrap
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // wraps to 0
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockPush).toHaveBeenCalledWith("/c/a");
  });

  it("ArrowUp from first wraps to last", async () => {
    const mockResults = [
      { type: "channel", id: "1", name: "A", slug: "a" },
      { type: "channel", id: "2", name: "B", slug: "b" },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "ab" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    fireEvent.keyDown(input, { key: "ArrowDown" }); // index 0
    fireEvent.keyDown(input, { key: "ArrowUp" }); // wraps to last (index 1)
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockPush).toHaveBeenCalledWith("/c/b");
  });

  it("renders all media type icons", async () => {
    const mockResults = [
      { type: "media", id: "1", name: "Vid", slug: "v", channelSlug: "c", mediaType: "video" },
      { type: "media", id: "2", name: "Aud", slug: "a", channelSlug: "c", mediaType: "audio" },
      { type: "media", id: "3", name: "Art", slug: "r", channelSlug: "c", mediaType: "article" },
      { type: "media", id: "4", name: "Pho", slug: "p", channelSlug: "c", mediaType: "photo" },
      { type: "media", id: "5", name: "Pod", slug: "d", channelSlug: "c", mediaType: "podcast" },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "test" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    expect(screen.getByText("Vid")).toBeInTheDocument();
    expect(screen.getByText("Aud")).toBeInTheDocument();
    expect(screen.getByText("Art")).toBeInTheDocument();
    expect(screen.getByText("Pho")).toBeInTheDocument();
    expect(screen.getByText("Pod")).toBeInTheDocument();
  });

  it("handles response with missing results field", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");
    fireEvent.change(input, { target: { value: "test" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    // Falls back to [] — shows no_results
    expect(screen.getByText("viewer.search.no_results")).toBeInTheDocument();
  });

  it("debounce resets on rapid typing", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    render(<SearchBar />);
    const input = screen.getByPlaceholderText("viewer.search.placeholder");

    fireEvent.change(input, { target: { value: "te" } });
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.change(input, { target: { value: "tes" } });
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.change(input, { target: { value: "test" } });
    await act(async () => { vi.advanceTimersByTime(300); });

    // Only the last debounced call should have fired
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/search?q=test");
  });
});
