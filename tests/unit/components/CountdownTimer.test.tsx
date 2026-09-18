// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import CountdownTimer from "@/components/CountdownTimer";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CountdownTimer", () => {
  // -----------------------------------------------------------
  // formatTime display
  // -----------------------------------------------------------
  describe("formatTime", () => {
    it("displays mm:ss when under one hour", () => {
      render(<CountdownTimer serverSeconds={125} />);
      expect(screen.getByText("02:05")).toBeInTheDocument();
    });

    it("displays h:mm:ss when one hour or more", () => {
      render(<CountdownTimer serverSeconds={3661} />);
      expect(screen.getByText("1:01:01")).toBeInTheDocument();
    });

    it("displays d h:mm:ss when one day or more", () => {
      // 1 day + 2 hours + 3 minutes + 4 seconds = 86400 + 7200 + 180 + 4
      render(<CountdownTimer serverSeconds={93784} />);
      expect(screen.getByText("1d 2:03:04")).toBeInTheDocument();
    });

    it("displays 00:00 when serverSeconds is 0", () => {
      render(<CountdownTimer serverSeconds={0} />);
      expect(screen.getByText("00:00")).toBeInTheDocument();
    });

    it("pads minutes and seconds with leading zeros", () => {
      render(<CountdownTimer serverSeconds={3601} />);
      // 1:00:01
      expect(screen.getByText("1:00:01")).toBeInTheDocument();
    });

    it("handles exactly one hour", () => {
      render(<CountdownTimer serverSeconds={3600} />);
      expect(screen.getByText("1:00:00")).toBeInTheDocument();
    });

    it("handles exactly one day", () => {
      render(<CountdownTimer serverSeconds={86400} />);
      expect(screen.getByText("1d 0:00:00")).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------
  // Countdown tick behavior
  // -----------------------------------------------------------
  describe("countdown", () => {
    it("counts down every second", () => {
      render(<CountdownTimer serverSeconds={5} />);
      expect(screen.getByText("00:05")).toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByText("00:04")).toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByText("00:03")).toBeInTheDocument();
    });

    it("stops at zero and does not go negative", () => {
      render(<CountdownTimer serverSeconds={2} />);
      expect(screen.getByText("00:02")).toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByText("00:01")).toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByText("00:00")).toBeInTheDocument();

      // Further ticks should stay at 00:00
      act(() => { vi.advanceTimersByTime(3000); });
      expect(screen.getByText("00:00")).toBeInTheDocument();
    });

    it("floors negative serverSeconds to 0", () => {
      render(<CountdownTimer serverSeconds={-5} />);
      expect(screen.getByText("00:00")).toBeInTheDocument();
    });

    it("floors fractional serverSeconds", () => {
      render(<CountdownTimer serverSeconds={3.7} />);
      expect(screen.getByText("00:03")).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------
  // onExpired callback
  // -----------------------------------------------------------
  describe("onExpired", () => {
    it("calls onExpired when timer reaches zero", () => {
      const onExpired = vi.fn();
      render(<CountdownTimer serverSeconds={2} onExpired={onExpired} />);

      act(() => { vi.advanceTimersByTime(2000); });
      expect(onExpired).toHaveBeenCalledTimes(1);
    });

    it("calls onExpired only once even after multiple ticks past zero", () => {
      const onExpired = vi.fn();
      render(<CountdownTimer serverSeconds={1} onExpired={onExpired} />);

      act(() => { vi.advanceTimersByTime(1000); });
      expect(onExpired).toHaveBeenCalledTimes(1);

      act(() => { vi.advanceTimersByTime(5000); });
      expect(onExpired).toHaveBeenCalledTimes(1);
    });

    it("calls onExpired immediately when serverSeconds is 0", () => {
      const onExpired = vi.fn();
      render(<CountdownTimer serverSeconds={0} onExpired={onExpired} />);
      // The initial tick() call should fire onExpired synchronously via the effect
      expect(onExpired).toHaveBeenCalledTimes(1);
    });

    it("does not crash when onExpired is not provided", () => {
      render(<CountdownTimer serverSeconds={1} />);
      act(() => { vi.advanceTimersByTime(2000); });
      // No error thrown
      expect(screen.getByText("00:00")).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------
  // Re-sync on serverSeconds prop change
  // -----------------------------------------------------------
  describe("re-sync from server", () => {
    it("resets countdown when serverSeconds prop changes", () => {
      const { rerender } = render(<CountdownTimer serverSeconds={10} />);
      expect(screen.getByText("00:10")).toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(3000); });
      expect(screen.getByText("00:07")).toBeInTheDocument();

      // Server heartbeat sends new remaining time
      rerender(<CountdownTimer serverSeconds={15} />);
      expect(screen.getByText("00:15")).toBeInTheDocument();
    });

    it("resets expiredRef so onExpired fires again after re-sync", () => {
      const onExpired = vi.fn();
      const { rerender } = render(<CountdownTimer serverSeconds={1} onExpired={onExpired} />);

      act(() => { vi.advanceTimersByTime(1000); });
      expect(onExpired).toHaveBeenCalledTimes(1);

      // Re-sync with a different serverSeconds value to trigger the effect
      rerender(<CountdownTimer serverSeconds={2} onExpired={onExpired} />);
      act(() => { vi.advanceTimersByTime(2000); });
      expect(onExpired).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------
  describe("cleanup", () => {
    it("clears interval on unmount", () => {
      const onExpired = vi.fn();
      const { unmount } = render(<CountdownTimer serverSeconds={5} onExpired={onExpired} />);

      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByText("00:04")).toBeInTheDocument();

      unmount();

      // After unmount, ticking should not call onExpired
      act(() => { vi.advanceTimersByTime(10000); });
      expect(onExpired).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------
  // CSS class styling branches
  // -----------------------------------------------------------
  describe("styling", () => {
    it("applies default styling when displaySeconds > 300", () => {
      const { container } = render(<CountdownTimer serverSeconds={600} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain("bg-[var(--theme-bg-secondary)]");
      expect(wrapper.className).toContain("text-[var(--theme-text)]");
      expect(wrapper.className).not.toContain("bg-[var(--theme-warning)]/15");
      expect(wrapper.className).not.toContain("bg-[var(--theme-error)]/15");
    });

    it("applies warning styling when displaySeconds is between 61 and 300", () => {
      const { container } = render(<CountdownTimer serverSeconds={200} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain("bg-[var(--theme-warning)]/15");
      expect(wrapper.className).toContain("text-[var(--theme-warning)]");
      expect(wrapper.className).not.toContain("bg-[var(--theme-error)]/15");
    });

    it("applies warning styling at exactly 300 seconds", () => {
      const { container } = render(<CountdownTimer serverSeconds={300} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain("bg-[var(--theme-warning)]/15");
    });

    it("applies critical styling when displaySeconds <= 60", () => {
      const { container } = render(<CountdownTimer serverSeconds={60} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain("bg-[var(--theme-error)]/15");
      expect(wrapper.className).toContain("text-[var(--theme-error)]");
    });

    it("applies critical styling at 0 seconds", () => {
      const { container } = render(<CountdownTimer serverSeconds={0} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain("bg-[var(--theme-error)]/15");
    });

    it("applies animate-pulse to SVG in critical state", () => {
      const { container } = render(<CountdownTimer serverSeconds={30} />);
      const svg = container.querySelector("svg");
      expect(svg?.className.baseVal || svg?.getAttribute("class")).toContain("animate-pulse");
    });

    it("does not apply animate-pulse to SVG in non-critical state", () => {
      const { container } = render(<CountdownTimer serverSeconds={600} />);
      const svg = container.querySelector("svg");
      const svgClass = svg?.className.baseVal || svg?.getAttribute("class") || "";
      expect(svgClass).not.toContain("animate-pulse");
    });

    it("transitions from default to warning as timer counts down", () => {
      const { container } = render(<CountdownTimer serverSeconds={302} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain("bg-[var(--theme-bg-secondary)]");

      // Tick down past 300 threshold
      act(() => { vi.advanceTimersByTime(2000); });
      expect(wrapper.className).toContain("bg-[var(--theme-warning)]/15");
    });

    it("transitions from warning to critical as timer counts down", () => {
      const { container } = render(<CountdownTimer serverSeconds={62} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain("bg-[var(--theme-warning)]/15");

      // Tick down past 60 threshold
      act(() => { vi.advanceTimersByTime(2000); });
      expect(wrapper.className).toContain("bg-[var(--theme-error)]/15");
    });
  });

  // -----------------------------------------------------------
  // Edge: displaySeconds exactly at boundary 61
  // -----------------------------------------------------------
  describe("boundary values", () => {
    it("61 seconds is warning (not critical)", () => {
      const { container } = render(<CountdownTimer serverSeconds={61} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain("bg-[var(--theme-warning)]/15");
      expect(wrapper.className).not.toContain("bg-[var(--theme-error)]/15");
    });

    it("301 seconds is default (not warning)", () => {
      const { container } = render(<CountdownTimer serverSeconds={301} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain("bg-[var(--theme-bg-secondary)]");
      expect(wrapper.className).not.toContain("bg-[var(--theme-warning)]/15");
    });
  });
});
