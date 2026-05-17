import { describe, it, expect, vi, afterEach } from "vitest";

const { isSetupCompleteMock } = vi.hoisted(() => ({
  isSetupCompleteMock: vi.fn(),
}));
vi.mock("@/lib/setup", () => ({
  isSetupComplete: isSetupCompleteMock,
}));

import { GET } from "@/app/api/setup/status/route";

describe("GET /api/setup/status", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns setup_complete: true when setup is done", async () => {
    isSetupCompleteMock.mockResolvedValue(true);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ setup_complete: true });
  });

  it("returns setup_complete: false when setup is pending", async () => {
    isSetupCompleteMock.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ setup_complete: false });
  });
});
