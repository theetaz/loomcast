import { z } from "zod";
import { PublishFailure } from "../../errors";

// `GET /{threads-user-id}/threads_publishing_limit?fields=quota_usage,config` returns
// `{"data": [{"quota_usage": 4, "config": {"quota_total": 250, "quota_duration": 86400}}]}`:
// the posts published in the rolling window and the window's size. The adapter reads it before
// creating a container, so a full quota waits instead of failing on the platform's side.

const count = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number);

export const ThreadsQuotaSchema = z.object({
  data: z
    .array(
      z.object({
        quota_usage: count.optional(),
        config: z
          .object({ quota_total: count.optional(), quota_duration: count.optional() })
          .optional(),
      }),
    )
    .default([]),
});
export type ThreadsQuota = z.infer<typeof ThreadsQuotaSchema>;

/** How long a channel whose quota is used up waits before it asks again. */
export const THREADS_QUOTA_RETRY_MS = 60 * 60_000;

/** The quota's usage and total, or null when the platform did not report them. */
export function threadsQuotaOf(quota: ThreadsQuota): { usage: number; total: number } | null {
  const entry = quota.data[0];
  const usage = entry?.quota_usage;
  const total = entry?.config?.quota_total;
  return usage === undefined || total === undefined ? null : { usage, total };
}

/**
 * Throws a retryable `rate_limited` failure when the quota is used up. The window rolls, so the
 * post asks again after `THREADS_QUOTA_RETRY_MS` (or the window, when it is shorter).
 */
export function assertThreadsQuota(quota: ThreadsQuota): void {
  const parsed = threadsQuotaOf(quota);
  if (parsed === null || parsed.usage < parsed.total) {
    return;
  }
  const windowMs = (quota.data[0]?.config?.quota_duration ?? 0) * 1_000;
  const retryAfterMs =
    windowMs > 0 ? Math.min(windowMs, THREADS_QUOTA_RETRY_MS) : THREADS_QUOTA_RETRY_MS;
  throw PublishFailure.of(
    "rate_limited",
    `The Threads account has used its publishing quota (${parsed.usage} of ${parsed.total}).`,
    { retryable: true, retryAfterMs, platformCode: "quota_usage" },
  );
}
