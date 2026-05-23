// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import HeartbeatManager from "@/components/HeartbeatManager";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HeartbeatManager", () => {
  it("renders nothing", () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ key: "k1" }) });
    const { container } = render(
      <HeartbeatManager productId="p1" onExpired={vi.fn()} onKeyRefreshed={vi.fn()} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("calls fetch on interval", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ key: "k1" }) });
    const onKeyRefreshed = vi.fn();

    render(
      <HeartbeatManager
        productId="p1"
        onExpired={vi.fn()}
        onKeyRefreshed={onKeyRefreshed}
        intervalMs={5000}
      />
    );

    // First interval fires
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetch).toHaveBeenCalledWith("/api/macaroons", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: "p1" }),
    });
  });

  it("calls onKeyRefreshed with key from response after the first interval", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ key: "new-key-123" }),
    });
    const onKeyRefreshed = vi.fn();

    render(
      <HeartbeatManager
        productId="p1"
        onExpired={vi.fn()}
        onKeyRefreshed={onKeyRefreshed}
        intervalMs={1000}
      />
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(onKeyRefreshed).toHaveBeenCalledWith("new-key-123");
  });

  it("calls onExpired when response is not ok", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });
    const onExpired = vi.fn();

    render(
      <HeartbeatManager
        productId="p1"
        onExpired={onExpired}
        onKeyRefreshed={vi.fn()}
        intervalMs={1000}
      />
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(onExpired).toHaveBeenCalled();
  });

  it("does not expire on network error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network"));
    const onExpired = vi.fn();

    render(
      <HeartbeatManager
        productId="p1"
        onExpired={onExpired}
        onKeyRefreshed={vi.fn()}
        intervalMs={1000}
      />
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("defers the first heartbeat by intervalMs — does NOT fire on mount", async () => {
    // Mount-on-fire would race with a freshly-stored cookie and could
    // silently invalidate a customer's just-paid access on a single
    // portal hiccup. Caller is responsible for the initial verification;
    // the heartbeat is purely for periodic re-checks.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ key: "k" }) });

    render(
      <HeartbeatManager
        productId="p1"
        onExpired={vi.fn()}
        onKeyRefreshed={vi.fn()}
      />
    );

    // Nothing yet — there's no initial-on-mount fetch.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();

    // Still nothing just before 30s.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch).not.toHaveBeenCalled();

    // First heartbeat fires at exactly 30s.
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Second at 60s.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("clears interval on unmount", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ key: "k" }) });

    const { unmount } = render(
      <HeartbeatManager
        productId="p1"
        onExpired={vi.fn()}
        onKeyRefreshed={vi.fn()}
        intervalMs={1000}
      />
    );

    // Let one heartbeat fire before unmounting.
    await vi.advanceTimersByTimeAsync(1000);
    const callsBeforeUnmount = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  it("calls onRemainingSeconds when response includes remaining_seconds", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ key: "k1", remaining_seconds: 300 }),
    });
    const onRemainingSeconds = vi.fn();

    render(
      <HeartbeatManager
        productId="p1"
        onExpired={vi.fn()}
        onKeyRefreshed={vi.fn()}
        onRemainingSeconds={onRemainingSeconds}
        intervalMs={1000}
      />
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(onRemainingSeconds).toHaveBeenCalledWith(300);
  });
});
