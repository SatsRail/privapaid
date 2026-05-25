const mockSettingsFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    settings: {
      findFirst: mockSettingsFindFirst,
    },
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isSetupComplete, clearSetupCache } from "@/lib/setup";

describe("setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isSetupComplete", () => {
    it("returns true when a settings row with setupCompleted exists", async () => {
      mockSettingsFindFirst.mockResolvedValue({ id: 1 });

      const result = await isSetupComplete();

      expect(mockSettingsFindFirst).toHaveBeenCalledWith({
        where: { setupCompleted: true },
        select: { id: true },
      });
      expect(result).toBe(true);
    });

    it("returns false when no settings row matches", async () => {
      mockSettingsFindFirst.mockResolvedValue(null);

      const result = await isSetupComplete();

      expect(result).toBe(false);
    });

    it("returns false when findFirst returns undefined", async () => {
      mockSettingsFindFirst.mockResolvedValue(undefined);

      const result = await isSetupComplete();

      expect(result).toBe(false);
    });
  });

  describe("clearSetupCache", () => {
    it("is a no-op function that does not throw", () => {
      expect(() => clearSetupCache()).not.toThrow();
    });

    it("returns undefined", () => {
      const result = clearSetupCache();
      expect(result).toBeUndefined();
    });
  });
});
