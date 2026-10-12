import { BRIDGE_TIMINGS } from "@loomcast/contracts";

export interface BackoffPolicy {
  /** Ceiling of the first delay. */
  readonly initialMs: number;
  /** The ceiling doubles per attempt up to this value. */
  readonly maxMs: number;
  /** A connection that stays up at least this long resets the attempt count. */
  readonly resetAfterMs: number;
}

/** 1 s doubling to 60 s, reset after 60 s of stable connection. */
export const DEFAULT_BACKOFF: BackoffPolicy = BRIDGE_TIMINGS.reconnect;

/** Doubling stops long before this, so `2 ** attempt` never overflows. */
const MAX_EXPONENT = 30;

/** The largest delay of a retry: `min(maxMs, initialMs * 2^attempt)`. */
export function backoffCeiling(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  const exponent = Math.min(Math.max(0, attempt), MAX_EXPONENT);
  return Math.min(policy.maxMs, policy.initialMs * 2 ** exponent);
}

/**
 * Full jitter: a uniformly random delay in `[0, ceiling)`. Spreading retries over the whole window
 * keeps many agents from reconnecting in lock-step after a server restart.
 */
export function fullJitterDelay(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  return Math.floor(random() * backoffCeiling(attempt, policy));
}

/** Tracks reconnect attempts for one connection. */
export class Backoff {
  readonly #policy: BackoffPolicy;
  readonly #random: () => number;
  readonly #now: () => number;
  #attempt = 0;
  #connectedAt: number | null = null;

  constructor(
    policy: BackoffPolicy = DEFAULT_BACKOFF,
    random: () => number = Math.random,
    now: () => number = Date.now,
  ) {
    this.#policy = policy;
    this.#random = random;
    this.#now = now;
  }

  /** Failed attempts since the last stable connection. */
  get attempt(): number {
    return this.#attempt;
  }

  /** Call when a connection opens. */
  connected(): void {
    this.#connectedAt = this.#now();
  }

  /** Call when a connection closes. A connection that stayed up long enough resets the count. */
  disconnected(): void {
    if (
      this.#connectedAt !== null &&
      this.#now() - this.#connectedAt >= this.#policy.resetAfterMs
    ) {
      this.#attempt = 0;
    }
    this.#connectedAt = null;
  }

  /** The delay before the next attempt. */
  next(): number {
    const delay = fullJitterDelay(this.#attempt, this.#policy, this.#random);
    this.#attempt += 1;
    return delay;
  }
}
