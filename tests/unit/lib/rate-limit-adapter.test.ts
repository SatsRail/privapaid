import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockHeaders = vi.fn().mockResolvedValue(
  new Headers({ "x-forwarded-for": "9.9.9.9" })
);
vi.mock("next/headers", () => ({
  headers: (...args: unknown[]) => mockHeaders(...args),
}));

import {
  rateLimit,
  setRateLimitStore,
  type RateLimitStore,
} from "@/lib/rate-limit";
import {
  createRedisRateLimitStore,
  type RedisLike,
} from "@/lib/rate-limit-redis";

describe("rate-limit adapter", () => {
  beforeEach(() => {
    mockHeaders.mockResolvedValue(new Headers({ "x-forwarded-for": "9.9.9.9" }));
  });

  afterEach(() => {
    // Reset to default in-memory store between tests so we don't leak state.
    setRateLimitStore(null);
  });

  it("delegates to a custom RateLimitStore when one is installed", async () => {
    const stub: RateLimitStore = {
      incr: vi.fn().mockResolvedValue({ count: 1, resetAt: Date.now() + 60000 }),
    };
    setRateLimitStore(stub);

    const result = await rateLimit("custom", 5, 60000);
    expect(result).toBeNull();
    expect(stub.incr).toHaveBeenCalledWith(
      expect.stringContaining("custom:"),
      60000
    );
  });

  it("returns 429 when the custom store reports over-limit count", async () => {
    const stub: RateLimitStore = {
      incr: vi.fn().mockResolvedValue({ count: 6, resetAt: Date.now() + 60000 }),
    };
    setRateLimitStore(stub);

    const result = await rateLimit("custom", 5, 60000);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    expect(result!.headers.get("Retry-After")).toBeTruthy();
  });

  it("falls back to in-memory when setRateLimitStore(null) is called", async () => {
    const stub: RateLimitStore = {
      incr: vi.fn().mockResolvedValue({ count: 99, resetAt: Date.now() + 60000 }),
    };
    setRateLimitStore(stub);
    setRateLimitStore(null);

    // Should not call the stub anymore.
    const result = await rateLimit(`fallback-${Date.now()}`, 5, 60000);
    expect(result).toBeNull();
    expect(stub.incr).not.toHaveBeenCalled();
  });
});

describe("createRedisRateLimitStore", () => {
  it("sets PEXPIRE only on the first request in a window", async () => {
    const calls: string[] = [];
    const fakeRedis: RedisLike = {
      incr: vi.fn().mockImplementation(async () => {
        calls.push("incr");
        return calls.filter((c) => c === "incr").length;
      }),
      pexpire: vi.fn().mockImplementation(async (_k: string, _ms: number, _mode?: string) => {
        calls.push("pexpire");
        return 1;
      }),
    };

    const store = createRedisRateLimitStore(fakeRedis);

    await store.incr("bucket:a", 60000);
    await store.incr("bucket:a", 60000);
    await store.incr("bucket:a", 60000);

    // First call: incr returns 1 → pexpire with no mode flag (pin TTL)
    // Subsequent calls: incr > 1 → pexpire with NX (don't extend window)
    expect(fakeRedis.incr).toHaveBeenCalledTimes(3);
    expect(fakeRedis.pexpire).toHaveBeenCalledTimes(3);
    expect(fakeRedis.pexpire).toHaveBeenNthCalledWith(1, "ratelimit:bucket:a", 60000);
    expect(fakeRedis.pexpire).toHaveBeenNthCalledWith(2, "ratelimit:bucket:a", 60000, "NX");
    expect(fakeRedis.pexpire).toHaveBeenNthCalledWith(3, "ratelimit:bucket:a", 60000, "NX");
  });

  it("returns the count from INCR as the bucket count", async () => {
    let counter = 0;
    const fakeRedis: RedisLike = {
      incr: vi.fn().mockImplementation(async () => ++counter),
      pexpire: vi.fn().mockResolvedValue(1),
    };
    const store = createRedisRateLimitStore(fakeRedis);

    const a = await store.incr("bucket:b", 60000);
    const b = await store.incr("bucket:b", 60000);
    expect(a.count).toBe(1);
    expect(b.count).toBe(2);
  });
});
