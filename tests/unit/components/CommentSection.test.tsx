// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockMutate = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: vi.fn(() => ({ data: null })),
}));

vi.mock("swr", () => ({
  default: vi.fn(() => ({ data: [], mutate: mockMutate })),
}));

vi.mock("@/lib/fetcher", () => ({
  fetcher: vi.fn(),
}));

vi.mock("@/i18n/useLocale", async () => {
  const { t: realT } = await import("@/i18n");
  const boundT = (key: string, params?: Record<string, string | number>) => realT("en", key, params);
  return { useLocale: () => ({ t: boundT, locale: "en" }) };
});

vi.mock("@/components/ui/Button", () => ({
  default: ({ children, loading, type, size, ...props }: { children: React.ReactNode; loading?: boolean; type?: string; size?: string; "data-testid"?: string; onClick?: () => void }) => (
    <button {...props} data-loading={loading} data-type={type} data-size={size} data-testid="submit-btn">{children}</button>
  ),
}));

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import CommentSection from "@/components/CommentSection";
import { useSession } from "next-auth/react";
import useSWR from "swr";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  mockMutate.mockClear();
  (useSession as ReturnType<typeof vi.fn>).mockReturnValue({ data: null });
  (useSWR as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ data: [], mutate: mockMutate });

  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, val: string) => { store[key] = val; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Sane defaults reflecting the simplified API: the parent (MediaLayout)
 * owns the single useMediaAccess hook and passes us `hasAccess` already
 * computed from `access.status === "active"`. We no longer run any
 * mount-time macaroon checks here; that's why the test file lost ~half
 * its scaffolding (no more `fetch` mocks for the macaroon-check first
 * call, etc.).
 */
const baseProps = {
  mediaId: "m1",
  productIds: ["p1"],
  hasAccess: false,
};

describe("CommentSection", () => {
  it("renders comment count", () => {
    render(<CommentSection {...baseProps} productIds={[]} />);
    expect(screen.getByText("Comments (0)")).toBeInTheDocument();
  });

  it("shows 'No comments yet.' when empty", () => {
    render(<CommentSection {...baseProps} productIds={[]} />);
    expect(screen.getByText("No comments yet.")).toBeInTheDocument();
  });

  it("renders existing comments", () => {
    (useSWR as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [
        { _id: "c1", body: "Great!", created_at: "2025-01-01T00:00:00Z", customer: { nickname: "Alice" } },
      ],
      mutate: mockMutate,
    });

    render(<CommentSection {...baseProps} productIds={[]} />);
    expect(screen.getByText("Great!")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  describe("YouTube-exact typography", () => {
    // Pin the EXACT sizes/weights so future "polish" passes can't drift
    // away from the YouTube parity the founder asked for.

    beforeEach(() => {
      (useSWR as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        data: [
          { _id: "c1", body: "Great body text.", created_at: "2025-01-01T00:00:00Z", customer: { nickname: "Alice" } },
        ],
        mutate: mockMutate,
      });
    });

    it("heading uses text-base font-bold (16px / 700) — YouTube's comments heading weight", () => {
      render(<CommentSection {...baseProps} productIds={[]} />);
      const heading = screen.getByRole("heading", { level: 3 });
      expect(heading.className).toContain("text-base");
      expect(heading.className).toContain("font-bold");
    });

    it("author name uses 13px / 500 medium (exact YouTube comment author sizing)", () => {
      render(<CommentSection {...baseProps} productIds={[]} />);
      const author = screen.getByText("Alice");
      expect(author.className).toContain("text-[13px]");
      expect(author.className).toContain("font-medium");
    });

    it("timestamp uses text-xs (12px) — visually de-emphasized vs author", () => {
      const { container } = render(<CommentSection {...baseProps} productIds={[]} />);
      // The timestamp is the second span in the author/timestamp row.
      const timestamp = container.querySelector('[data-testid="comment-item"] span:last-child');
      expect(timestamp?.className).toContain("text-xs");
    });

    it("comment body uses text-sm with leading-[1.43] for YouTube's reading rhythm", () => {
      render(<CommentSection {...baseProps} productIds={[]} />);
      const body = screen.getByText("Great body text.");
      expect(body.className).toContain("text-sm");
      expect(body.className).toContain("leading-[1.43]");
    });

    it("renders a 40px circular avatar with the nickname's first letter", () => {
      const { container } = render(<CommentSection {...baseProps} productIds={[]} />);
      const item = container.querySelector('[data-testid="comment-item"]');
      const avatar = item?.querySelector("div");
      expect(avatar?.className).toContain("h-10");
      expect(avatar?.className).toContain("w-10");
      expect(avatar?.className).toContain("rounded-full");
      expect(avatar?.textContent).toBe("A"); // Alice → "A"
    });

    it("falls back to '?' in the avatar when the nickname is empty", () => {
      (useSWR as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        data: [
          { _id: "c2", body: "Hi", created_at: "2025-01-01T00:00:00Z", customer: { nickname: "" } },
        ],
        mutate: mockMutate,
      });
      const { container } = render(<CommentSection {...baseProps} productIds={[]} />);
      const item = container.querySelector('[data-testid="comment-item"]');
      const avatar = item?.querySelector("div");
      expect(avatar?.textContent).toBe("?");
    });
  });

  it("shows access-denied message when no access and has productIds", () => {
    render(<CommentSection {...baseProps} hasAccess={false} />);
    expect(screen.getByText(/Only paying viewers can comment/)).toBeInTheDocument();
  });

  it("shows comment form when user has access", () => {
    render(<CommentSection {...baseProps} hasAccess={true} />);
    expect(screen.getByPlaceholderText("Share your thoughts...")).toBeInTheDocument();
  });

  it("shows nickname field for anonymous (non-customer) users", () => {
    render(<CommentSection {...baseProps} hasAccess={true} />);
    expect(screen.getByPlaceholderText("Your nickname")).toBeInTheDocument();
  });

  it("hides nickname field for customer users", () => {
    (useSession as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { user: { role: "customer", name: "Bob" } },
    });

    render(<CommentSection {...baseProps} hasAccess={true} />);

    expect(screen.getByPlaceholderText("Share your thoughts...")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Your nickname")).not.toBeInTheDocument();
  });

  it("shows customer form even when hasAccess=false (customer login is its own access path)", () => {
    (useSession as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { user: { role: "customer", name: "Bob" } },
    });

    render(<CommentSection {...baseProps} hasAccess={false} />);

    expect(screen.getByPlaceholderText("Share your thoughts...")).toBeInTheDocument();
  });

  it("prevents submit with empty body", async () => {
    (useSession as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { user: { role: "customer", name: "Bob" } },
    });

    render(<CommentSection {...baseProps} hasAccess={true} />);

    const form = screen.getByPlaceholderText("Share your thoughts...").closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    // No POST should have happened — the body was empty.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows error when anonymous user submits without nickname", async () => {
    render(<CommentSection {...baseProps} hasAccess={true} />);

    const textarea = screen.getByPlaceholderText("Share your thoughts...");
    fireEvent.change(textarea, { target: { value: "Hello" } });

    const form = textarea.closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    expect(screen.getByText("Please enter a nickname")).toBeInTheDocument();
  });

  it("submits comment successfully", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ _id: "new1", body: "Hello", created_at: "2025-01-01", customer: { nickname: "Me" } }),
    });

    render(<CommentSection {...baseProps} hasAccess={true} />);

    fireEvent.change(screen.getByPlaceholderText("Your nickname"), { target: { value: "Me" } });
    fireEvent.change(screen.getByPlaceholderText("Share your thoughts..."), { target: { value: "Hello" } });

    const form = screen.getByPlaceholderText("Share your thoughts...").closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockMutate).toHaveBeenCalled();
    expect(localStorage.setItem).toHaveBeenCalledWith("privapaid_nickname", "Me");
  });

  it("calls onUnauthorized and shows access-unverified when POST returns 402", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: async () => ({ error: "Payment required to comment" }),
    });
    const onUnauthorized = vi.fn();

    render(<CommentSection {...baseProps} hasAccess={true} onUnauthorized={onUnauthorized} />);

    fireEvent.change(screen.getByPlaceholderText("Your nickname"), { target: { value: "Me" } });
    fireEvent.change(screen.getByPlaceholderText("Share your thoughts..."), { target: { value: "Hi" } });

    const form = screen.getByPlaceholderText("Share your thoughts...").closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    // The component delegates the access flip to the parent — the parent's
    // useMediaAccess hook will re-check and may re-render us with hasAccess=false.
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    // And we display the access-unverified inline error.
    expect(screen.getByText(/couldn't verify your access/i)).toBeInTheDocument();
  });

  it("calls onUnauthorized on POST 401 and shows access-unverified", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "Unauthorized" }),
    });
    const onUnauthorized = vi.fn();

    render(<CommentSection {...baseProps} hasAccess={true} onUnauthorized={onUnauthorized} />);

    fireEvent.change(screen.getByPlaceholderText("Your nickname"), { target: { value: "Me" } });
    fireEvent.change(screen.getByPlaceholderText("Share your thoughts..."), { target: { value: "Hi" } });

    const form = screen.getByPlaceholderText("Share your thoughts...").closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/couldn't verify your access/i)).toBeInTheDocument();
  });

  it("does not throw when onUnauthorized is omitted and POST returns 401", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "Unauthorized" }),
    });

    // No onUnauthorized prop — this used to crash with the verify-failed
    // path setting state on an unmounted component; with optional chaining
    // it now no-ops cleanly.
    render(<CommentSection {...baseProps} hasAccess={true} />);

    fireEvent.change(screen.getByPlaceholderText("Your nickname"), { target: { value: "Me" } });
    fireEvent.change(screen.getByPlaceholderText("Share your thoughts..."), { target: { value: "Hi" } });

    const form = screen.getByPlaceholderText("Share your thoughts...").closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    expect(screen.getByText(/couldn't verify your access/i)).toBeInTheDocument();
  });

  it("handles server error on submit", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Bad request" }),
    });

    render(<CommentSection {...baseProps} hasAccess={true} />);

    fireEvent.change(screen.getByPlaceholderText("Your nickname"), { target: { value: "Me" } });
    fireEvent.change(screen.getByPlaceholderText("Share your thoughts..."), { target: { value: "Hi" } });

    const form = screen.getByPlaceholderText("Share your thoughts...").closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    expect(screen.getByText("Bad request")).toBeInTheDocument();
  });

  it("handles server error without message", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    });

    render(<CommentSection {...baseProps} hasAccess={true} />);

    fireEvent.change(screen.getByPlaceholderText("Your nickname"), { target: { value: "Me" } });
    fireEvent.change(screen.getByPlaceholderText("Share your thoughts..."), { target: { value: "Hi" } });

    const form = screen.getByPlaceholderText("Share your thoughts...").closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    expect(screen.getByText("Failed to post comment")).toBeInTheDocument();
  });

  it("handles network error on submit", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network"));

    render(<CommentSection {...baseProps} hasAccess={true} />);

    fireEvent.change(screen.getByPlaceholderText("Your nickname"), { target: { value: "Me" } });
    fireEvent.change(screen.getByPlaceholderText("Share your thoughts..."), { target: { value: "Hi" } });

    const form = screen.getByPlaceholderText("Share your thoughts...").closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("loads nickname from localStorage on mount", async () => {
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue("SavedNick");

    render(<CommentSection {...baseProps} hasAccess={true} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Your nickname")).toHaveValue("SavedNick");
    });
  });

  it("skips form when no productIds (not pay-gated content)", () => {
    render(<CommentSection {...baseProps} productIds={[]} hasAccess={false} />);
    expect(screen.queryByPlaceholderText("Share your thoughts...")).not.toBeInTheDocument();
    expect(screen.queryByText(/Only paying viewers/)).not.toBeInTheDocument();
  });

  it("submits comment without nickname for customer", async () => {
    (useSession as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { user: { role: "customer", name: "Bob" } },
    });

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ _id: "c2", body: "Hey", created_at: "2025-01-01", customer: { nickname: "Bob" } }),
    });

    render(<CommentSection {...baseProps} hasAccess={true} />);

    fireEvent.change(screen.getByPlaceholderText("Share your thoughts..."), { target: { value: "Hey" } });

    const form = screen.getByPlaceholderText("Share your thoughts...").closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    const postCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const postedBody = JSON.parse(postCall[1].body);
    expect(postedBody.body).toBe("Hey");
    expect(postedBody.nickname).toBeUndefined();
  });
});
