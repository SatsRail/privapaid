import { NextResponse } from "next/server";
import { headers } from "next/headers";

/**
 * Shape of an "increment-and-report" rate-limit backend.
 *
 * `incr(bucketKey, windowMs)` atomically:
 *   1. Increments the request count for `bucketKey`.
 *   2. Returns `{ count, resetAt }` for that bucket.
 *
 * `resetAt` is a Unix ms timestamp. The store decides when to start a new
 * window — the only contract is that `count` reflects requests in the
 * current window.
 *
 * Self-hosters who deploy a single Next.js process keep the in-memory
 * default. Multi-instance / serverless deploys should set REDIS_URL so
 * the rate limit is enforced across replicas — see
 * `src/lib/rate-limit-redis.ts`.
 */
export interface RateLimitStore {
  incr(bucketKey: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

// ── In-memory store (default) ─────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const memStore = new Map<string, RateLimitEntry>();

let lastCleanup = Date.now();
function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  for (const [key, entry] of memStore) {
    if (entry.resetAt <= now) memStore.delete(key);
  }
}

const inMemoryStore: RateLimitStore = {
  async incr(bucketKey, windowMs) {
    cleanup();
    const now = Date.now();
    let entry = memStore.get(bucketKey);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      memStore.set(bucketKey, entry);
    }
    entry.count++;
    return { count: entry.count, resetAt: entry.resetAt };
  },
};

// ── Active store selection ────────────────────────────────────────────

let activeStore: RateLimitStore = inMemoryStore;

/**
 * Swap the rate-limit backend. Used by the Redis adapter at startup, and
 * by tests that need to substitute a stub. If `null` is passed, falls
 * back to the in-memory default.
 *
 * Single-process default: in-memory. Multi-instance deployments should
 * call this from `instrumentation.ts` after constructing the Redis store.
 */
export function setRateLimitStore(store: RateLimitStore | null): void {
  activeStore = store ?? inMemoryStore;
}

// Exported for tests that want to introspect the default store directly.
export const __defaultInMemoryStore = inMemoryStore;

// ── Public API (unchanged signature) ──────────────────────────────────

/**
 * Apply a per-IP rate limit. Returns null if the request is allowed, or
 * a 429 NextResponse with `Retry-After` / `X-RateLimit-*` headers when
 * the bucket is over the limit.
 *
 * @param key - Bucket name (e.g., "signup", "macaroon_write")
 * @param limit - Max requests per window
 * @param windowMs - Window size, defaults to 60s
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMs = 60_000
): Promise<NextResponse | null> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "unknown";

  const bucketKey = `${key}:${ip}`;
  const { count, resetAt } = await activeStore.incr(bucketKey, windowMs);

  const resetSec = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));

  if (count > limit) {
    const res = NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
    res.headers.set("X-RateLimit-Limit", String(limit));
    res.headers.set("X-RateLimit-Remaining", "0");
    res.headers.set("X-RateLimit-Reset", String(resetSec));
    res.headers.set("Retry-After", String(resetSec));
    return res;
  }

  return null;
}
