/**
 * Opt-in Redis backend for `rate-limit.ts`.
 *
 * This module deliberately does NOT import a Redis client. Operators who
 * want distributed rate limiting pick their own client (Upstash REST,
 * ioredis, node-redis, etc.) and wire it in from `src/instrumentation.ts`:
 *
 *   import { Redis } from "@upstash/redis";
 *   import { createRedisRateLimitStore } from "@/lib/rate-limit-redis";
 *   import { setRateLimitStore } from "@/lib/rate-limit";
 *
 *   if (process.env.REDIS_URL) {
 *     const client = new Redis({ url: process.env.REDIS_URL });
 *     setRateLimitStore(createRedisRateLimitStore(client));
 *   }
 *
 * Why this is on the operator and not auto-installed here: the previous
 * design dynamically imported `@upstash/redis`, which Turbopack flagged
 * as "module not found" during builds (the dep is intentionally absent
 * from package.json). Pushing the import to the caller keeps the build
 * clean and lets operators swap the underlying client without touching
 * this file.
 *
 * Counter strategy: per-bucket Redis key with `INCR` + `PEXPIRE NX` so
 * the TTL is only set on the first increment of a window. The count
 * returned by `INCR` is authoritative; we compute `resetAt` from the
 * local clock + window. Clock skew across replicas is fine because
 * `resetAt` is only used to populate response headers.
 */

import type { RateLimitStore } from "@/lib/rate-limit";

/**
 * Minimal subset of the Upstash/ioredis surface this adapter depends on.
 * Both libraries satisfy this shape — pick whichever you prefer and
 * pass the client into `createRedisRateLimitStore`.
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
