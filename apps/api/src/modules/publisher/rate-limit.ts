import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonObject, PublishError } from "@loomcast/contracts";
import { channels } from "@loomcast/db";
import { eq, sql } from "drizzle-orm";
import type { Executor } from "../../lib/db";
import {
  type FetchLike,
  type GraphUsage,
  parseUsageHeaders,
  usageSnapshot,
} from "../../lib/meta-graph";

// Platform rate limits, per channel. `channels.rate_limit` keeps the latest usage report of the
// account: the Meta throttling headers (`X-App-Usage`, `X-Business-Use-Case-Usage`) of its last
// Graph or Threads API call, or the rate-limit headers the X adapter stores, plus `blockedUntil`
// after the platform refused a call as rate limited. Before a publish, status or insights call the
// scheduler asks `throttleOf`: above `USAGE_THROTTLE_PERCENT` on any dimension the call waits for
// the window the report gives, so no call is made while the channel is near its limit.

/** Usage, in percent of a limit, above which a channel's calls wait. */
export const USAGE_THROTTLE_PERCENT = 80;

/**
 * How long a Meta usage report holds when it gives no time to regain access: the app and business
 * use case limits are counted over a rolling hour.
 */
export const META_USAGE_WINDOW_MS = 60 * 60_000;

/** How long a channel waits after a rate-limit error that says nothing about when to retry. */
export const RATE_LIMITED_FALLBACK_MS = 15 * 60_000;

/** Why and until when a channel's calls wait. */
export interface Throttle {
  until: Date;
  /** The dimension over its threshold, such as `appUsage.call_count`. */
  dimension: string;
}

const META_DIMENSIONS = ["call_count", "total_cputime", "total_time"] as const;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function timeOf(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** The later of two throttles; null counts as none. */
function later(a: Throttle | null, b: Throttle | null): Throttle | null {
  if (a === null) return b;
  if (b === null) return a;
  return b.until.getTime() > a.until.getTime() ? b : a;
}

/** A Meta usage object (`{call_count, total_cputime, total_time}`, percentages) over threshold. */
function metaDimensionOver(usage: JsonObject): string | null {
  for (const dimension of META_DIMENSIONS) {
    const value = finiteNumber(usage[dimension]);
    if (value !== null && value > USAGE_THROTTLE_PERCENT) {
      return dimension;
    }
  }
  return null;
}

function metaThrottle(report: JsonObject, capturedAt: number): Throttle | null {
  let found: Throttle | null = null;
  const app = asObject(report.appUsage);
  const appDimension = app === null ? null : metaDimensionOver(app);
  if (appDimension !== null) {
    found = {
      until: new Date(capturedAt + META_USAGE_WINDOW_MS),
      dimension: `appUsage.${appDimension}`,
    };
  }
  const business = asObject(report.businessUseCaseUsage);
  for (const [businessId, entries] of Object.entries(business ?? {})) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      const usage = asObject(entry);
      if (usage === null) {
        continue;
      }
      const regainMinutes = finiteNumber(usage.estimated_time_to_regain_access) ?? 0;
      const dimension = metaDimensionOver(usage);
      if (regainMinutes > 0) {
        found = later(found, {
          until: new Date(capturedAt + regainMinutes * 60_000),
          dimension: `businessUseCaseUsage.${businessId}.estimated_time_to_regain_access`,
        });
      } else if (dimension !== null) {
        found = later(found, {
          until: new Date(capturedAt + META_USAGE_WINDOW_MS),
          dimension: `businessUseCaseUsage.${businessId}.${dimension}`,
        });
      }
    }
  }
  return found;
}

/** An X window (`limit`, `remaining`, reset time) more than the threshold used. */
function xWindowThrottle(
  report: JsonObject,
  keys: { limit: string; remaining: string; resetAt: string },
): Throttle | null {
  const limit = finiteNumber(report[keys.limit]);
  const remaining = finiteNumber(report[keys.remaining]);
  const resetAt = timeOf(report[keys.resetAt]);
  if (limit === null || remaining === null || resetAt === null || limit <= 0) {
    return null;
  }
  const usedPercent = ((limit - remaining) / limit) * 100;
  return usedPercent > USAGE_THROTTLE_PERCENT || remaining <= 0
    ? { until: new Date(resetAt), dimension: keys.remaining }
    : null;
}

/**
 * Whether a channel's calls must wait, from its `channels.rate_limit` report: until
 * `blockedUntil`; until the reported window ends when a Meta usage (app or business use case)
 * is above `USAGE_THROTTLE_PERCENT` or gives a time to regain access; until an X window resets
 * when more than that share of it is used. Null when nothing holds the channel back at `now`.
 */
export function throttleOf(report: JsonObject | null | undefined, now: Date): Throttle | null {
  if (report === null || report === undefined) {
    return null;
  }
  let found: Throttle | null = null;
  const blockedUntil = timeOf(report.blockedUntil);
  if (blockedUntil !== null) {
    found = { until: new Date(blockedUntil), dimension: "blockedUntil" };
  }
  const capturedAt = timeOf(report.capturedAt);
  if (capturedAt !== null) {
    found = later(found, metaThrottle(report, capturedAt));
  }
  if (report.platform === "x") {
    found = later(
      found,
      xWindowThrottle(report, { limit: "limit", remaining: "remaining", resetAt: "resetAt" }),
    );
    found = later(
      found,
      xWindowThrottle(report, {
        limit: "userDayLimit",
        remaining: "userDayRemaining",
        resetAt: "userDayResetAt",
      }),
    );
  }
  return found !== null && found.until.getTime() > now.getTime() ? found : null;
}

/**
 * How long to back off after a `rate_limited` error: what the platform said (`retryAfterMs`) or
 * `RATE_LIMITED_FALLBACK_MS`, and never less than the channel's own report holds it back.
 */
export function rateLimitedRetryMs(
  error: Pick<PublishError, "retryAfterMs">,
  report: JsonObject | null | undefined,
  now: Date,
): number {
  const said = error.retryAfterMs !== undefined && error.retryAfterMs > 0 ? error.retryAfterMs : 0;
  const throttle = throttleOf(report, now);
  const held = throttle === null ? 0 : throttle.until.getTime() - now.getTime();
  return Math.max(said > 0 ? said : RATE_LIMITED_FALLBACK_MS, held);
}

/**
 * Updates a channel's report: the Meta usage of its latest call (both kinds replaced, so a stale
 * one never lingers) and, after a rate-limit error, `blockedUntil`. Other keys, such as the X
 * adapter's, are kept. Does nothing when there is nothing to record.
 */
export async function recordChannelUsage(
  executor: Executor,
  channelId: string,
  input: { usage?: GraphUsage | null; blockedUntil?: Date | null; at: Date },
): Promise<void> {
  const patch: JsonObject = {};
  if (input.usage !== undefined && input.usage !== null) {
    const snapshot = usageSnapshot(input.usage, input.at);
    patch.capturedAt = snapshot.capturedAt ?? input.at.toISOString();
    patch.appUsage = snapshot.appUsage ?? null;
    patch.businessUseCaseUsage = snapshot.businessUseCaseUsage ?? null;
  }
  if (input.blockedUntil !== undefined && input.blockedUntil !== null) {
    patch.blockedUntil = input.blockedUntil.toISOString();
  }
  if (Object.keys(patch).length === 0) {
    return;
  }
  await executor
    .update(channels)
    .set({
      rateLimit: sql`coalesce(${channels.rateLimit}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(eq(channels.id, channelId));
}

/** Collects the latest Meta usage report of the calls made inside one `observe` run. */
export interface UsageScope {
  usage: GraphUsage | null;
}

export interface UsageObserver {
  /** A `fetch` that reads the throttling headers of every response into the running scope. */
  readonly fetch: FetchLike;
  /** Runs `run` and returns its result with the last usage report its calls received. */
  observe<T>(run: () => Promise<T>): { scope: UsageScope; result: Promise<T> };
}

/**
 * Watches the Meta adapters' calls without changing them: the adapters are built with
 * `observer.fetch`, and the publisher runs each adapter call inside `observe`, so the headers
 * land in that call's scope even when several posts publish at once.
 */
export function createUsageObserver(base?: FetchLike): UsageObserver {
  const storage = new AsyncLocalStorage<UsageScope>();
  const doFetch: FetchLike = base ?? ((input, init) => fetch(input, init));
  return {
    async fetch(input, init) {
      const response = await doFetch(input, init);
      const scope = storage.getStore();
      if (scope !== undefined) {
        const usage = parseUsageHeaders(response.headers);
        if (usage !== null) {
          scope.usage = usage;
        }
      }
      return response;
    },
    observe<T>(run: () => Promise<T>) {
      const scope: UsageScope = { usage: null };
      return { scope, result: storage.run(scope, run) };
    },
  };
}
