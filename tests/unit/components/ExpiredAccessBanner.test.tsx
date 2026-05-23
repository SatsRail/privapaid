// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

let mockLocale: "en" | "es" = "en";
vi.mock("@/i18n/useLocale", async () => {
  const { t: realT } = await import("@/i18n");
  return {
    useLocale: () => ({
      t: (key: string, params?: Record<string, string | number>) =>
        realT(mockLocale, key, params),
      locale: mockLocale,
    }),
  };
});

import ExpiredAccessBanner from "@/components/ExpiredAccessBanner";

describe("ExpiredAccessBanner", () => {
  it("renders the title + body with the formatted expiry date", () => {
    // 2026-05-15 21:20:45 UTC → en-US locale renders the long month + day
    // plus time. Asserting on a substring keeps the test robust to TZ
    // differences in CI.
    mockLocale = "en";
    const expiredAt = new Date("2026-05-15T21:20:45.228Z");
    render(<ExpiredAccessBanner expiredAt={expiredAt} />);

    expect(screen.getByText("Your access expired")).toBeInTheDocument();
    // Body contains the localized date. Don't pin exact text — Intl
    // formatting varies slightly across Node versions and timezones.
    const body = screen.getByText(/Your previous access ended on/i);
    expect(body).toBeInTheDocument();
    expect(body.textContent).toMatch(/May/);
    expect(body.textContent).toMatch(/2026/);
  });

  it("renders in Spanish locale", () => {
    mockLocale = "es";
    const expiredAt = new Date("2026-05-15T21:20:45.228Z");
    render(<ExpiredAccessBanner expiredAt={expiredAt} />);
    expect(screen.getByText("Tu acceso expiró")).toBeInTheDocument();
    expect(screen.getByText(/Tu acceso anterior terminó el/i)).toBeInTheDocument();
  });

  it("uses an a11y status role so screen readers announce it", () => {
    // The banner conveys important context for the user's decision; making
    // it discoverable to screen readers is the lowest-effort win here.
    mockLocale = "en";
    render(<ExpiredAccessBanner expiredAt={new Date("2026-05-15T00:00:00Z")} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
