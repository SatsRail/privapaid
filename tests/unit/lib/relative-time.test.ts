import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { formatTimeAgo } from "@/lib/relative-time";

describe("formatTimeAgo", () => {
  // Pin "now" so the bucket boundaries are deterministic.
  const NOW = new Date("2026-05-23T21:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty string for missing / invalid inputs", () => {
    expect(formatTimeAgo(undefined)).toBe("");
    expect(formatTimeAgo(null)).toBe("");
    expect(formatTimeAgo("not-a-date")).toBe("");
  });

  it("returns 'now' bucket for very recent timestamps", () => {
    const justNow = new Date(NOW.getTime() - 10_000); // 10 seconds ago
    const result = formatTimeAgo(justNow, "en");
    expect(result).toMatch(/now|second/i);
  });

  it("returns minutes bucket for under-hour deltas", () => {
    const minutesAgo = new Date(NOW.getTime() - 5 * 60_000); // 5 minutes ago
    const result = formatTimeAgo(minutesAgo, "en");
    expect(result).toMatch(/minute/i);
  });

  it("returns hours bucket for under-day deltas", () => {
    const hoursAgo = new Date(NOW.getTime() - 3 * 3_600_000); // 3 hours ago
    expect(formatTimeAgo(hoursAgo, "en")).toMatch(/hour/i);
  });

  it("returns days bucket for under-week deltas", () => {
    const daysAgo = new Date(NOW.getTime() - 3 * 86_400_000); // 3 days ago
    expect(formatTimeAgo(daysAgo, "en")).toMatch(/day/i);
  });

  it("returns weeks bucket for under-month deltas", () => {
    const weeksAgo = new Date(NOW.getTime() - 10 * 86_400_000); // 10 days
    expect(formatTimeAgo(weeksAgo, "en")).toMatch(/week/i);
  });

  it("returns months bucket for under-year deltas", () => {
    const monthsAgo = new Date(NOW.getTime() - 60 * 86_400_000); // 60 days
    expect(formatTimeAgo(monthsAgo, "en")).toMatch(/month/i);
  });

  it("returns years bucket for over-year deltas", () => {
    const yearsAgo = new Date(NOW.getTime() - 400 * 86_400_000); // ~13 months
    expect(formatTimeAgo(yearsAgo, "en")).toMatch(/year/i);
  });

  it("respects the locale parameter (Spanish renders 'hace ...')", () => {
    const daysAgo = new Date(NOW.getTime() - 3 * 86_400_000);
    const result = formatTimeAgo(daysAgo, "es");
    // Spanish RelativeTimeFormat uses "hace" prefix or "anteayer" / "ayer".
    expect(result).toMatch(/d(í|i)as|hace/i);
  });

  it("falls back to English on unknown locale (no throw)", () => {
    const daysAgo = new Date(NOW.getTime() - 2 * 86_400_000);
    expect(() => formatTimeAgo(daysAgo, "xx-INVALID")).not.toThrow();
  });

  it("accepts ISO string inputs", () => {
    const iso = new Date(NOW.getTime() - 86_400_000).toISOString();
    expect(formatTimeAgo(iso, "en")).toMatch(/day|yesterday/i);
  });
});
