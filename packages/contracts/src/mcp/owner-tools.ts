import { z } from "zod";
import {
  CalendarResponseSchema,
  CreatePostRequestSchema,
  checkCalendarRange,
  MAX_CALENDAR_FILTER_IDS,
  ReschedulePostRequestSchema,
  ScheduledPostSchema,
} from "../api/calendar";
import { ChannelSchema } from "../api/channels";
import { CreateReviewRequestSchema } from "../api/reviews";
import { IdSchema, TimestampSchema } from "../common";
import { PipelineStateSchema, ReviewDecisionSchema } from "../enums";
import type { McpToolContract } from "./contract";

/** A decision on the item's current version, as the web app's review form sends it. */
export const ContentReviewInputSchema = CreateReviewRequestSchema.safeExtend({
  itemId: IdSchema,
});
export type ContentReviewInput = z.infer<typeof ContentReviewInputSchema>;

/** The review that was stored and the state the item moved to. */
export const ContentReviewOutputSchema = z.object({
  reviewId: IdSchema,
  itemId: IdSchema,
  decision: ReviewDecisionSchema,
  state: PipelineStateSchema,
});
export type ContentReviewOutput = z.infer<typeof ContentReviewOutputSchema>;

export const ChannelListInputSchema = z.object({});
export type ChannelListInput = z.infer<typeof ChannelListInputSchema>;

/** Every channel, by platform and name. Credentials never leave the server. */
export const ChannelListOutputSchema = z.object({
  channels: z.array(ChannelSchema),
});
export type ChannelListOutput = z.infer<typeof ChannelListOutputSchema>;

/** At most `MAX_CALENDAR_FILTER_IDS` ids, without repeats. */
const ChannelIdsSchema = z
  .array(IdSchema)
  .min(1)
  .max(MAX_CALENDAR_FILTER_IDS)
  .refine((ids) => new Set(ids).size === ids.length, { message: "Ids must not repeat" });

/**
 * Posts scheduled in `[from, to)` and the open cadence slots in it, at most 62 days, as the web
 * app's calendar shows them. `projectId` and `channelIds` narrow the result.
 */
export const CalendarListPostsInputSchema = z
  .object({
    from: TimestampSchema,
    to: TimestampSchema,
    projectId: IdSchema.optional(),
    channelIds: ChannelIdsSchema.optional(),
  })
  .superRefine(checkCalendarRange);
export type CalendarListPostsInput = z.infer<typeof CalendarListPostsInputSchema>;

export const CalendarListPostsOutputSchema = CalendarResponseSchema;
export type CalendarListPostsOutput = z.infer<typeof CalendarListPostsOutputSchema>;

/** Schedules an approved item on a channel, at least two minutes ahead. */
export const CalendarSchedulePostInputSchema = CreatePostRequestSchema;
export type CalendarSchedulePostInput = z.infer<typeof CalendarSchedulePostInputSchema>;

/** Moves a post. `expectedUpdatedAt` is the post's `updatedAt` as last read. */
export const CalendarReschedulePostInputSchema = ReschedulePostRequestSchema.extend({
  postId: IdSchema,
});
export type CalendarReschedulePostInput = z.infer<typeof CalendarReschedulePostInputSchema>;

export const CalendarCancelPostInputSchema = z.object({
  postId: IdSchema,
});
export type CalendarCancelPostInput = z.infer<typeof CalendarCancelPostInputSchema>;

/** The post after the change. */
export const CalendarPostOutputSchema = z.object({
  post: ScheduledPostSchema,
});
export type CalendarPostOutput = z.infer<typeof CalendarPostOutputSchema>;

/**
 * The owner's review and publishing tools: the moves the owner makes in the web app's review
 * queue and calendar. They need `mcp:admin`, which only the owner's tokens carry, and each call
 * acts as the owner, so ordinary tokens (and producer sessions' job tokens) still never approve
 * or schedule.
 */
export const ownerTools = {
  "content.review": {
    name: "content.review",
    scope: "mcp:admin",
    jobTokens: "deny",
    projectBinding: "input",
    description:
      "Owner only. Decide an item in review as the owner: approve its current version (it must have a render), request changes (with a comment; a revision is queued unless enqueueRevision is false) or reject it. versionId must be the item's current version, from content.get.",
    input: ContentReviewInputSchema,
    output: ContentReviewOutputSchema,
  },
  "channel.list": {
    name: "channel.list",
    scope: "mcp:admin",
    jobTokens: "deny",
    projectBinding: "none",
    description:
      "Owner only. List the channels posts can be scheduled on, with their platform, name, handle, status, whether credentials are connected and whether they publish in dry-run.",
    input: ChannelListInputSchema,
    output: ChannelListOutputSchema,
  },
  "calendar.list_posts": {
    name: "calendar.list_posts",
    scope: "mcp:admin",
    jobTokens: "deny",
    projectBinding: "input",
    description:
      "Owner only. List the posts scheduled between two times (at most 62 days) and the open cadence slots from now on, optionally for one project or some channels. Each post carries the updatedAt that calendar.reschedule_post expects.",
    input: CalendarListPostsInputSchema,
    output: CalendarListPostsOutputSchema,
  },
  "calendar.schedule_post": {
    name: "calendar.schedule_post",
    scope: "mcp:admin",
    jobTokens: "deny",
    projectBinding: "input",
    description:
      "Owner only. Schedule an approved item on a channel at a time at least two minutes ahead, as the owner. The post publishes its current version; an item already queued on that channel is a conflict.",
    input: CalendarSchedulePostInputSchema,
    output: CalendarPostOutputSchema,
  },
  "calendar.reschedule_post": {
    name: "calendar.reschedule_post",
    scope: "mcp:admin",
    jobTokens: "deny",
    projectBinding: "none",
    description:
      "Owner only. Move a planned, queued, failed or missed post to a new time at least two minutes ahead. expectedUpdatedAt is the post's updatedAt as last read; a post changed since is a conflict.",
    input: CalendarReschedulePostInputSchema,
    output: CalendarPostOutputSchema,
  },
  "calendar.cancel_post": {
    name: "calendar.cancel_post",
    scope: "mcp:admin",
    jobTokens: "deny",
    projectBinding: "none",
    description:
      "Owner only. Cancel a post that has not started publishing. An item left without a queued post goes back to approved.",
    input: CalendarCancelPostInputSchema,
    output: CalendarPostOutputSchema,
  },
} as const satisfies Record<string, McpToolContract>;

export type OwnerToolName = keyof typeof ownerTools;
