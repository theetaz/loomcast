import type { JsonObject } from "@loomcast/contracts";
import { z } from "zod";
import type { GraphClient } from "../../../../lib/meta-graph";
import { PublishFailure } from "../../errors";
import type { PlatformRequest } from "../../requests";
import { INSTAGRAM_QUOTA_RETRY_MS, sendStep } from "./graph";

// The content publishing quota: `GET /{ig-user-id}/content_publishing_limit?fields=quota_usage,
// config` answers `{data: [{quota_usage, config: {quota_total, quota_duration}}]}` (Graph API
// v26.0). The reference gives 50 posts per 24 hours (`quota_duration` 86400 s) while the content
// publishing guide says 100; the adapter trusts what the endpoint reports, and falls back to the
// lower figure (the publisher's daily rate gate uses it too).

/** Posts per 24 hours when the endpoint does not say. */
export const INSTAGRAM_DEFAULT_QUOTA = 50;

const QuotaSchema = z.object({
  data: z
    .array(
      z.object({
        quota_usage: z.coerce.number().int().min(0).optional(),
        config: z
          .object({
            quota_total: z.coerce.number().int().min(0).optional(),
            quota_duration: z.coerce.number().int().min(0).optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});

export interface InstagramQuota {
  usage: number;
  total: number;
  durationSeconds: number;
}

/** The quota in an answer of the endpoint; null when the answer has no usage. */
export function parseQuota(body: unknown): InstagramQuota | null {
  const parsed = QuotaSchema.safeParse(body);
  const entry = parsed.success ? parsed.data.data[0] : undefined;
  if (entry?.quota_usage === undefined) {
    return null;
  }
  return {
    usage: entry.quota_usage,
    total: entry.config?.quota_total ?? INSTAGRAM_DEFAULT_QUOTA,
    durationSeconds: entry.config?.quota_duration ?? 86_400,
  };
}

/** The quota as recorded on the attempt. */
export function quotaRecord(quota: InstagramQuota | null): JsonObject {
  return quota === null
    ? { quota_usage: null }
    : {
        quota_usage: quota.usage,
        quota_total: quota.total,
        quota_duration: quota.durationSeconds,
      };
}

/**
 * Asks for the account's publishing quota (the `publishing_limit` step) and throws a retryable
 * `rate_limited` failure when it is used up. The window moves, so the post tries again after
 * `INSTAGRAM_QUOTA_RETRY_MS` (never later than the window itself). An answer without a usage
 * lets the post go on: `media_publish` enforces the limit anyway.
 */
export async function checkQuota(
  client: GraphClient,
  step: PlatformRequest,
  input: { accessToken: string; signal: AbortSignal; retryMs?: number },
): Promise<InstagramQuota | null> {
  const response = await sendStep<unknown>(client, step, input);
  const quota = parseQuota(response.data);
  if (quota !== null && quota.total > 0 && quota.usage >= quota.total) {
    const windowMs = quota.durationSeconds > 0 ? quota.durationSeconds * 1_000 : undefined;
    const retryAfterMs = Math.min(input.retryMs ?? INSTAGRAM_QUOTA_RETRY_MS, windowMs ?? Infinity);
    throw PublishFailure.of(
      "rate_limited",
      `The Instagram account used its quota of ${quota.total} posts in 24 hours.`,
      { retryAfterMs },
    );
  }
  return quota;
}
