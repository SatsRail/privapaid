// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import AccessTimerPill from "@/components/AccessTimerPill";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function pillSpan(): HTMLSpanElement {
  // The outer pill is the only inline-flex element rendered
  return document.querySelector("span.inline-flex") as HTMLSpanElement;
}

describe("AccessTimerPill", () => {
  it("renders neutral styling well above 5 minutes", () => {
    render(<AccessTimerPill serverSeconds={600} locale="en" />);
    expect(screen.getByText(/10:00/)).toBeInTheDocument();
    const cls = pillSpan().className;
    expect(cls).toContain("bg-[var(--theme-bg-secondary)]");
    expect(cls).not.toContain("bg-[var(--theme-warning)]");
    expect(cls).not.toContain("bg-[var(--theme-error)]");
  });

  it("renders warning styling when between 1 and 5 minutes", () => {
    render(<AccessTimerPill serverSeconds={120} locale="en" />);
    const cls = pillSpan().className;
    expect(cls).toContain("bg-[var(--theme-warning)]");
    expect(cls).not.toContain("bg-[var(--theme-error)]");
  });

  it("renders critical styling at or below 60 seconds", () => {
    render(<AccessTimerPill serverSeconds={45} locale="en" />);
    const cls = pillSpan().className;
    expect(cls).toContain("bg-[var(--theme-error)]");
    expect(document.querySelector("svg")?.getAttribute("class")).toContain("animate-pulse");
  });

  it("floors to zero when serverSeconds is negative", () => {
    render(<AccessTimerPill serverSeconds={-5} locale="en" />);
    expect(screen.getByText(/00:00/)).toBeInTheDocument();
  });

  it("decrements once per tick interval", () => {
    render(<AccessTimerPill serverSeconds={120} locale="en" />);
    expect(screen.getByText(/02:00/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText(/01:57/)).toBeInTheDocument();
  });

  it("stops at zero when the countdown elapses past it", () => {
    render(<AccessTimerPill serverSeconds={2} locale="en" />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText(/00:00/)).toBeInTheDocument();
  });
});
