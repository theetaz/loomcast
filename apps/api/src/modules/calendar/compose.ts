import {
  type ContentVersion,
  formatMediaIssues,
  type PipelineState,
  PLATFORM_LABELS,
  type PostFormat,
  type PostMediaEntry,
  type PostOptions,
  PRODUCTION_STATES,
  platformRefusal,
  type ScheduledPost,
} from "@loomcast/contracts";
import { type ContentItemRow, channels, scheduledPosts } from "@loomcast/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Executor, Transaction } from "../../lib/db";
import { HttpError, validationFailed } from "../../lib/errors";
import type { ContentService, PipelineActor } from "../content";
import { missingArtifact } from "../content/support";
import type { ReviewsService } from "../reviews/service";
import { APPROVED_ITEM_STATES } from "./posts";
import type { CalendarService } from "./service";

// Scheduling a composed post on several channels at once, all or nothing, shared by the owner's
// MCP `post.schedule` and the machine API: check every channel first, then submit the version,
// approve it when the caller may, and create one post per channel in the caller's transaction.

/** Why the item cannot go out on one channel. `format` marks a platform that refuses the format. */
export interface ChannelRefusal {
  path: string;
  message: string;
  format: boolean;
}

/**
 * The reasons the item cannot go out on each channel, in the order given: a channel that is not
 * one of `workspaceId`'s, a disabled channel, a platform that does not publish the format, or an
 * open post of the item already
 * there (when `itemId` names an item). Checked before anything changes, so a refusal names every
 * channel at once. `pathOf` names each channel's field in the request.
 */
export async function refusedChannels(
  tx: Executor,
  workspaceId: string,
  itemId: string | null,
  version: { format: PostFormat; media: readonly Pick<PostMediaEntry, "type">[] },
  channelIds: readonly string[],
  pathOf: (index: number) => string = (index) => `channelIds.${index}`,
): Promise<ChannelRefusal[]> {
  const rows = await tx
    .select({
      id: channels.id,
      platform: channels.platform,
      status: channels.status,
      displayName: channels.displayName,
    })
    .from(channels)
    .where(and(inArray(channels.id, [...channelIds]), eq(channels.workspaceId, workspaceId)));
  const open =
    itemId === null
      ? []
      : await tx
          .select({ channelId: scheduledPosts.channelId })
          .from(scheduledPosts)
          .where(
            and(
              eq(scheduledPosts.itemId, itemId),
              inArray(scheduledPosts.channelId, [...channelIds]),
              ne(scheduledPosts.status, "cancelled"),
            ),
          );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const taken = new Set(open.map((row) => row.channelId));
  const refused: ChannelRefusal[] = [];
  for (const [index, id] of channelIds.entries()) {
    const path = pathOf(index);
    const channel = byId.get(id);
    if (channel === undefined) {
      refused.push({ path, message: "No channel of this workspace has that id", format: false });
      continue;
    }
    const name = `${channel.displayName} (${PLATFORM_LABELS[channel.platform]})`;
    const refusal = platformRefusal(channel.platform, version);
    if (refusal !== null) {
      refused.push({ path, message: `${name}: ${refusal.replace(/\.$/, "")}`, format: true });
    } else if (channel.status === "disabled") {
      refused.push({ path, message: `${name}: the channel is disabled`, format: false });
    } else if (taken.has(id)) {
      refused.push({ path, message: `${name}: the item already has a post here`, format: false });
    }
  }
  return refused;
}

/**
 * Throws when any channel was refused: 422 `format_not_supported` when every refusal is about the
 * format, 400 `validation_failed` naming each channel otherwise.
 */
export function throwRefusals(refused: readonly ChannelRefusal[]): void {
  if (refused.length === 0) {
    return;
  }
  if (refused.every((issue) => issue.format)) {
    throw new HttpError(
      422,
      "format_not_supported",
      `No post was scheduled. ${refused.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}.`,
    );
  }
  throw validationFailed(
    refused.map(({ path, message }) => ({ path, message })),
    "No post was scheduled: some channels were refused.",
  );
}

export interface ComposedScheduleDeps {
  content: Pick<ContentService, "submit" | "getItem">;
  reviews: Pick<ReviewsService, "create">;
  calendar: Pick<CalendarService, "create" | "plan">;
}

export interface ComposedScheduleInput {
  /** The item, locked by the caller (`lockItem`). */
  item: ContentItemRow;
  /** Its current version. */
  version: ContentVersion;
  targets: readonly { channelId: string; options?: PostOptions | undefined }[];
  scheduledAt: string;
  /**
   * Approve the version as `actor` (a user), with this review comment, and queue the posts. Null
   * leaves the item in review with planned posts that wait for a person's approval.
   */
  approve: { comment?: string } | null;
}

export interface ComposedScheduleResult {
  state: PipelineState;
  reviewId: string | null;
  posts: ScheduledPost[];
}

/**
 * Submits the item's current version when it is still in production (422 `missing_artifact` when
 * its media do not fit its format), approves it when asked, then creates a post per target:
 * queued once the item is approved, planned while it waits in review. Runs in `tx`, so a refusal
 * of any target leaves everything as it was. Check the channels with `refusedChannels` first.
 */
export async function scheduleComposed(
  tx: Transaction,
  deps: ComposedScheduleDeps,
  input: ComposedScheduleInput,
  actor: PipelineActor,
): Promise<ComposedScheduleResult> {
  const { item, version } = input;
  let state: PipelineState = item.state;
  if ((PRODUCTION_STATES as readonly PipelineState[]).includes(state)) {
    const issues = formatMediaIssues(version);
    if (issues.length > 0) {
      throw missingArtifact(`The post is not ready: ${issues.join(" ")}`, "media");
    }
    state = (await deps.content.submit(item.id, { versionId: version.id }, actor, { tx })).state;
  }
  let reviewId: string | null = null;
  if (input.approve !== null && state === "review") {
    const decided = await deps.reviews.create(
      item.id,
      {
        versionId: version.id,
        decision: "approve",
        ...(input.approve.comment === undefined ? {} : { comment: input.approve.comment }),
      },
      actor,
      { tx },
    );
    if (decided === null) {
      throw new Error("content item vanished while it was approved");
    }
    reviewId = decided.review.id;
    state = decided.item.state;
  }

  const approved = APPROVED_ITEM_STATES.includes(state);
  const posts: ScheduledPost[] = [];
  for (const target of input.targets) {
    const request = {
      itemId: item.id,
      channelId: target.channelId,
      scheduledAt: input.scheduledAt,
      ...(target.options === undefined ? {} : { options: target.options }),
    };
    posts.push(
      approved
        ? await deps.calendar.create(request, actor, { tx })
        : await deps.calendar.plan(request, actor, { tx }),
    );
  }
  const after = await deps.content.getItem(item.id, tx);
  return { state: after?.state ?? state, reviewId, posts };
}
