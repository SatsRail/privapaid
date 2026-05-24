/**
 * Opt-in Redis backend for `rate-limit.ts`.
 *
 * Activated by setting `REDIS_URL` in env and calling
 * `installRedisRateLimitStoreFromEnv()` from `src/instrumentation.ts`.
 * The dependency is dynamically imported so single-process self-hosters
 * who don't need it can avoid the install.
 *
 * Why this exists: the default in-memory store is process-local. Multi-
 * instance deployments (Railway with replicas, Vercel serverless, any
 * autoscaling target) need a shared bucket so the documented 5/min
 * signup limit actually means 5/min across the fleet.
 *
 * Counter strategy: per-bucket Redis key with `INCR` + `PEXPIRE NX` so
 * the TTL is only set on the first increment of a window. Reads neither
 * `GET` nor `TTL` after the increment — the count returned by `INCR` is
 * authoritative, and we compute `resetAt` from the local clock + window.
 * Clock skew across replicas is a non-issue because `resetAt` is only
 * used to populate response headers.
 */

import type { RateLimitStore } from "@/lib/rate-limit";
import { setRateLimitStore } from "@/lib/rate-limit";

/**
 * Minimal subset of the Upstash/ioredis surface we depend on. Both
 * libraries satisfy this shape; pick one in your deployment.
 */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number, mode?: "NX" | "XX"): Promise<number>;
}

export function createRedisRateLimitStore(redis: RedisLike): RateLimitStore {
  return {
    async incr(bucketKey, windowMs) {
      const key = `ratelimit:${bucketKey}`;
      const count = await redis.incr(key);
      if (count === 1) {
        // First request in a fresh window — pin the TTL.
        await redis.pexpire(key, windowMs);
      } else {
        // Refuse to extend an existing window (NX) so the limit can't
        // be slid forward by attacker traffic.
        await redis.pexpire(key, windowMs, "NX");
      }
      return { count, resetAt: Date.now() + windowMs };
    },
  };
}

/**
 * Convenience: parse REDIS_URL, build a client, install the store.
 * Returns true when a Redis store was installed; false when REDIS_URL
 * was absent (caller can decide whether to log a warning).
 *
 * Imports the `@upstash/redis` client dynamically so projects that
 * don't ship it can skip the install. Swap the import for `ioredis`
 * if you prefer a TCP client over the REST flavor.
 */
export async function installRedisRateLimitStoreFromEnv(): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) return false;

  try {
    // Resolved at runtime so missing-package errors fall through to the
    // try/catch instead of breaking the build. The @ts-expect-error
    // acknowledges that `@upstash/redis` is an optional peer — operators
    // who set REDIS_URL install it themselves.
    // @ts-expect-error optional peer dependency, resolved at runtime
    const mod = (await import("@upstash/redis")) as unknown as {
      Redis: { new (opts: { url: string }): RedisLike };
    };
    const client = new mod.Redis({ url });
    setRateLimitStore(createRedisRateLimitStore(client));
    return true;
  } catch (err) {
    // Don't crash the process — fall back to in-memory and log loudly.
    console.error(
      "rate-limit-redis: REDIS_URL set but failed to initialize. Falling back to in-memory limiter.",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}
