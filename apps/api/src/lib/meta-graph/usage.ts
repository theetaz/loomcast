import type { JsonObject } from "@loomcast/contracts";

// Meta reports how close an app and a business are to their rate limits in two response headers.
// The client keeps both on every response (and on errors), so callers can store the latest report
// on the channel and hold back before a limit is reached.

/** The throttling headers of one response, parsed. Null fields were absent or not JSON. */
export interface GraphUsage {
  /** `X-App-Usage`: `{call_count, total_cputime, total_time}` as percentages. */
  appUsage: JsonObject | null;
  /**
   * `X-Business-Use-Case-Usage`: per business id, a list of `{type, call_count, total_cputime,
   * total_time, estimated_time_to_regain_access}` (minutes).
   */
  businessUseCaseUsage: JsonObject | null;
}

export const APP_USAGE_HEADER = "x-app-usage";
export const BUSINESS_USE_CASE_USAGE_HEADER = "x-business-use-case-usage";

function parseObject(value: string | null): JsonObject | null {
  if (value === null || value.length > 16_384) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

/** The usage headers of `headers`; null when neither is present. */
export function parseUsageHeaders(headers: Headers): GraphUsage | null {
  const appUsage = parseObject(headers.get(APP_USAGE_HEADER));
  const businessUseCaseUsage = parseObject(headers.get(BUSINESS_USE_CASE_USAGE_HEADER));
  if (appUsage === null && businessUseCaseUsage === null) {
    return null;
  }
  return { appUsage, businessUseCaseUsage };
}

/**
 * How long Meta says to wait before calls work again: the largest
 * `estimated_time_to_regain_access` (minutes) of the business use case report, in milliseconds.
 * Undefined when the report gives none.
 */
export function regainAccessDelayMs(usage: GraphUsage | null): number | undefined {
  let minutes = 0;
  for (const entries of Object.values(usage?.businessUseCaseUsage ?? {})) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      const value =
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as JsonObject).estimated_time_to_regain_access
          : undefined;
      if (typeof value === "number" && Number.isFinite(value) && value > minutes) {
        minutes = value;
      }
    }
  }
  return minutes > 0 ? minutes * 60_000 : undefined;
}

/** The usage as one JSON object for `channels.rate_limit`, with the time it was captured. */
export function usageSnapshot(usage: GraphUsage, capturedAt: Date): JsonObject {
  return {
    capturedAt: capturedAt.toISOString(),
    ...(usage.appUsage === null ? {} : { appUsage: usage.appUsage }),
    ...(usage.businessUseCaseUsage === null
      ? {}
      : { businessUseCaseUsage: usage.businessUseCaseUsage }),
  };
}
