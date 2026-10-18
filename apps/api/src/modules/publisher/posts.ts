import {
  DEFAULT_FORMAT_RULES,
  effectivePublishMode,
  type PublishAttempt,
  type PublishMode,
  PublishModeSchema,
  type ScheduledPost,
} from "@loomcast/contracts";
import {
  channels,
  contentItems,
  contentVersions,
  formats,
  formatVersions,
  type PublishAttemptRow,
  type ScheduledPostRow,
  scheduledPosts,
  series,
} from "@loomcast/db";
import { eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../../lib/db";

// Scheduled posts as the API shows them. Project, platform and publish mode come from joins: the
// item's project, the channel's platform, and `effectivePublishMode` of the series format and the
// channel. The calendar and the publisher both map posts here.

function formatModeOf(value: unknown): PublishMode {
  const parsed = PublishModeSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_FORMAT_RULES.publishMode;
}

export function toScheduledPost(
  row: ScheduledPostRow,
  joined: {
    projectId: string;
    platform: ScheduledPost["platform"];
    requiresApproval: boolean;
    formatMode: unknown;
    item: ScheduledPost["item"];
  },
): ScheduledPost {
  return {
    id: row.id,
    projectId: joined.projectId,
    itemId: row.itemId,
    versionId: row.versionId,
    channelId: row.channelId,
    seriesId: row.seriesId,
    platform: joined.platform,
    scheduledAt: row.scheduledAt.toISOString(),
    status: row.status,
    dryRun: row.dryRun,
    publishMode: effectivePublishMode(formatModeOf(joined.formatMode), joined.requiresApproval),
    externalId: row.externalId,
    permalink: row.permalink,
    attempts: row.attempts,
    lastError: row.lastError ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    options: row.options,
    item: joined.item,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The posts with these ids, mapped, in no particular order. Unknown ids are left out. */
export async function loadScheduledPosts(
  executor: Executor,
  ids: readonly string[],
): Promise<ScheduledPost[]> {
  if (ids.length === 0) {
    return [];
  }
  const rows = await executor
    .select({
      post: scheduledPosts,
      projectId: contentItems.projectId,
      title: contentItems.title,
      state: contentItems.state,
      format: contentVersions.format,
      posterAssetId: contentVersions.posterAssetId,
      platform: channels.platform,
      requiresApproval: channels.requiresApproval,
      formatMode: sql<unknown>`${formatVersions.rules} -> 'publishMode'`,
    })
    .from(scheduledPosts)
    .innerJoin(contentItems, eq(contentItems.id, scheduledPosts.itemId))
    .innerJoin(contentVersions, eq(contentVersions.id, contentItems.currentVersionId))
    .innerJoin(channels, eq(channels.id, scheduledPosts.channelId))
    .leftJoin(series, eq(series.id, scheduledPosts.seriesId))
    .leftJoin(formats, eq(formats.id, series.formatId))
    .leftJoin(formatVersions, eq(formatVersions.id, formats.currentVersionId))
    .where(inArray(scheduledPosts.id, [...ids]));
  return rows.map((row) =>
    toScheduledPost(row.post, {
      projectId: row.projectId,
      platform: row.platform,
      requiresApproval: row.requiresApproval,
      formatMode: row.formatMode,
      item: {
        title: row.title,
        state: row.state,
        format: row.format,
        posterAssetId: row.posterAssetId,
      },
    }),
  );
}

export async function loadScheduledPost(
  executor: Executor,
  id: string,
): Promise<ScheduledPost | null> {
  const [post] = await loadScheduledPosts(executor, [id]);
  return post ?? null;
}

export function toPublishAttempt(row: PublishAttemptRow): PublishAttempt {
  return {
    id: row.id,
    postId: row.postId,
    attempt: row.attempt,
    adapter: row.adapter,
    dryRun: row.dryRun,
    request: row.request ?? null,
    response: row.response ?? null,
    error: row.error ?? null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
