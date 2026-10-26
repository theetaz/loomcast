import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { PlatformSchema, PostStatusSchema, PublishModeSchema } from "../enums";
import { PostOptionsSchema } from "../publishing/formats";
import { PermalinkSchema, PublishErrorSchema } from "../publishing/request";
import { csvIdsQuerySchema } from "./common";
import { ContentItemSchema } from "./content";

/** The longest range one calendar request (or `calendar.get_slots` call) may cover. */
export const MAX_CALENDAR_RANGE_DAYS = 62;
export const MAX_CALENDAR_RANGE_MS = MAX_CALENDAR_RANGE_DAYS * 24 * 60 * 60_000;

/** A new or moved post must be at least this far in the future. */
export const MIN_SCHEDULE_LEAD_MS = 2 * 60_000;

/** Most channels or series one calendar request may filter on. */
export const MAX_CALENDAR_FILTER_IDS = 50;

/**
 * Checks a `{from, to}` range: `to` after `from`, at most `MAX_CALENDAR_RANGE_DAYS` apart. Use it
 * in a `superRefine` of any schema with those two timestamps.
 */
export function checkCalendarRange(
  range: { from: string; to: string },
  ctx: z.RefinementCtx,
): void {
  const span = Date.parse(range.to) - Date.parse(range.from);
  if (!(span > 0)) {
    ctx.addIssue({ code: "custom", message: "The range must end after it starts", path: ["to"] });
  } else if (span > MAX_CALENDAR_RANGE_MS) {
    ctx.addIssue({
      code: "custom",
      message: `The range must not exceed ${MAX_CALENDAR_RANGE_DAYS} days`,
      path: ["to"],
    });
  }
}

/** What a post shows of its item: enough for a calendar chip or an inbox row. */
export const PostItemSchema = ContentItemSchema.pick({
  title: true,
  state: true,
  format: true,
  posterAssetId: true,
});
export type PostItem = z.infer<typeof PostItemSchema>;

/** One item on one channel at one time. */
export const ScheduledPostSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  itemId: IdSchema,
  /** The approved version it publishes; null while the post is only `planned`. */
  versionId: IdSchema.nullable(),
  channelId: IdSchema,
  seriesId: IdSchema.nullable(),
  platform: PlatformSchema,
  scheduledAt: TimestampSchema,
  status: PostStatusSchema,
  /** Fixed when the post is created: the channel's switch or the server's dry-run mode. */
  dryRun: z.boolean(),
  /** `effectivePublishMode` of the series' format and the channel. */
  publishMode: PublishModeSchema,
  /** The platform's id of the published post. */
  externalId: z.string().nullable(),
  permalink: PermalinkSchema.nullable(),
  /** Publish attempts so far. */
  attempts: z.number().int().min(0),
  lastError: PublishErrorSchema.nullable(),
  publishedAt: TimestampSchema.nullable(),
  /** Per-platform options of this post (collaborators, a link, a video title). */
  options: PostOptionsSchema,
  item: PostItemSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ScheduledPost = z.infer<typeof ScheduledPostSchema>;

/**
 * Schedules an approved item on a channel: creates a `queued` post and its publish task. The time
 * must be at least `MIN_SCHEDULE_LEAD_MS` ahead; an open post of the same item on the same channel
 * is a `409 conflict`. The channel's platform must publish the item's format
 * (`PLATFORM_FORMATS`), otherwise `422 format_not_supported`.
 */
export const CreatePostRequestSchema = z.object({
  itemId: IdSchema,
  channelId: IdSchema,
  scheduledAt: TimestampSchema,
  options: PostOptionsSchema.optional(),
});
export type CreatePostRequest = z.infer<typeof CreatePostRequestSchema>;

/**
 * Moves a post. `expectedUpdatedAt` is the `updatedAt` the client last saw: a stale value is a
 * `409 conflict`. Only `RESCHEDULABLE_POST_STATUSES` move (`409 post_not_editable` otherwise), and
 * the new time must be at least `MIN_SCHEDULE_LEAD_MS` ahead.
 */
export const ReschedulePostRequestSchema = z.object({
  scheduledAt: TimestampSchema,
  expectedUpdatedAt: TimestampSchema,
});
export type ReschedulePostRequest = z.infer<typeof ReschedulePostRequestSchema>;

/**
 * `GET /api/calendar`: posts scheduled in `[from, to)` and the open cadence slots in it, at most
 * `MAX_CALENDAR_RANGE_DAYS` long. Lists take comma-separated ids.
 */
export const CalendarQuerySchema = z
  .object({
    from: TimestampSchema,
    to: TimestampSchema,
    workspaceId: IdSchema.optional(),
    seriesIds: csvIdsQuerySchema(MAX_CALENDAR_FILTER_IDS).optional(),
    channelIds: csvIdsQuerySchema(MAX_CALENDAR_FILTER_IDS).optional(),
  })
  .superRefine(checkCalendarRange);
export type CalendarQuery = z.infer<typeof CalendarQuerySchema>;

/**
 * A cadence slot of a series on one of its enabled channels. `postId` is set when a post holds the
 * slot; without it the slot is open.
 */
export const CalendarSlotSchema = z.object({
  at: TimestampSchema,
  seriesId: IdSchema,
  channelId: IdSchema,
  postId: IdSchema.optional(),
});
export type CalendarSlot = z.infer<typeof CalendarSlotSchema>;

/**
 * Every post in the range, and the slots from now to the end of the range. Past slots are left
 * out; a slot whose post was moved elsewhere shows as open.
 */
export const CalendarResponseSchema = z.object({
  posts: z.array(ScheduledPostSchema),
  slots: z.array(CalendarSlotSchema),
});
export type CalendarResponse = z.infer<typeof CalendarResponseSchema>;

/** `GET /api/approvals`, optionally for one workspace. */
export const ApprovalsQuerySchema = z.object({
  workspaceId: IdSchema.optional(),
});
export type ApprovalsQuery = z.infer<typeof ApprovalsQuerySchema>;

/**
 * An item in `review` waiting for a decision. `deadlineAt` is the earliest time of its open posts,
 * null when none is planned; `posts` are those open posts.
 */
export const ApprovalItemSchema = z.object({
  item: ContentItemSchema,
  deadlineAt: TimestampSchema.nullable(),
  posts: z.array(ScheduledPostSchema),
});
export type ApprovalItem = z.infer<typeof ApprovalItemSchema>;

/**
 * Items waiting for approval, nearest deadline first (no deadline last, then by `updatedAt`), and
 * missed posts, most recent first, which can be rescheduled.
 */
export const ApprovalsInboxSchema = z.object({
  items: z.array(ApprovalItemSchema),
  missed: z.array(ScheduledPostSchema),
});
export type ApprovalsInbox = z.infer<typeof ApprovalsInboxSchema>;
