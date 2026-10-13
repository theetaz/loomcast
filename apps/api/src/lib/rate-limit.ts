import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import type { Clock } from "./clock";
import { rateLimited } from "./errors";

export interface RateLimitOptions {
  /** Requests allowed in a burst, and the bucket size. */
  capacity: number;
  /** Time in which an empty bucket refills completely. */
  intervalMs: number;
  /** Buckets kept before full ones are swept. Bounds memory under a flood of distinct keys. */
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Tokens left after this request. */
  remaining: number;
  /** When `allowed` is false: time until one token is available again. */
  retryAfterMs: number;
}

export interface RateLimiter {
  take(key: string, cost?: number): RateLimitResult;
  reset(key: string): void;
  /** Number of tracked buckets. */
  readonly size: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const DEFAULT_MAX_KEYS = 10_000;

/**
 * In-memory token bucket per key. Each bucket holds `capacity` tokens and refills continuously at
 * `capacity / intervalMs`, so "5 per minute" allows a burst of 5 and then one every 12 seconds.
 * State is per process, which matches the single api process of the deployment.
 */
export function createRateLimiter(options: RateLimitOptions, clock: Clock): RateLimiter {
  const { capacity, intervalMs } = options;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const refillPerMs = capacity / intervalMs;
  const buckets = new Map<string, Bucket>();

  function refill(bucket: Bucket, now: number): void {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.updatedAt = now;
  }

  function sweep(now: number): void {
    for (const [key, bucket] of buckets) {
      refill(bucket, now);
      if (bucket.tokens >= capacity) {
        buckets.delete(key);
      }
    }
  }

  return {
    take(key, cost = 1) {
      const now = clock.now().getTime();
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        if (buckets.size >= maxKeys) {
          sweep(now);
        }
        bucket = { tokens: capacity, updatedAt: now };
        buckets.set(key, bucket);
      } else {
        refill(bucket, now);
      }
      if (bucket.tokens >= cost) {
        bucket.tokens -= cost;
        return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
      }
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.ceil((cost - bucket.tokens) / refillPerMs),
      };
    },
    reset(key) {
      buckets.delete(key);
    },
    get size() {
      return buckets.size;
    },
  };
}

/** Takes one token for `key`, throwing a 429 `HttpError` with `Retry-After` when none is left. */
export function consume(limiter: RateLimiter, key: string): void {
  const result = limiter.take(key);
  if (!result.allowed) {
    throw rateLimited(result.retryAfterMs);
  }
}

/** Middleware form of `consume`: the key comes from the request, for example the client address. */
export function rateLimit(
  limiter: RateLimiter,
  key: (c: Context<AppEnv>) => string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    consume(limiter, key(c));
    await next();
  };
}
