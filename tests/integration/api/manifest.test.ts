import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetInstanceConfig } = vi.hoisted(() => ({
  mockGetInstanceConfig: vi.fn(),
}));
vi.mock("@/config/instance", () => ({ getInstanceConfig: mockGetInstanceConfig }));

import { GET } from "@/app/manifest.webmanifest/route";

describe("GET /manifest.webmanifest", () => {
  beforeEach(() => {
    mockGetInstanceConfig.mockResolvedValue({
      name: "Demo Studio",
      theme: { primary: "#3ea6ff", bg: "#0f0f0f" },
    });
  });

  it("returns a standalone PWA manifest built from instance config", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");

    const body = await res.json();
    expect(body.name).toBe("Demo Studio");
    expect(body.short_name).toBe("Demo Studio");
    expect(body.start_url).toBe("/");
    // `standalone` is what unlocks Web Push on iOS Safari.
    expect(body.display).toBe("standalone");
    expect(body.theme_color).toBe("#3ea6ff");
    expect(body.background_color).toBe("#0f0f0f");
    expect(Array.isArray(body.icons)).toBe(true);
    expect(body.icons.length).toBeGreaterThan(0);
  });
});
