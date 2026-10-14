import { type Channel, ownerTools, type ScheduledPost } from "@loomcast/contracts";
import type { CalendarService } from "../../calendar/service";
import type { ContentService, PipelineActor } from "../../content";
import type { ReviewsService } from "../../reviews/service";
import type { McpCaller } from "../caller";
import { defineTool, McpToolError, type ToolDefinition } from "./registry";

export interface OwnerToolsDeps {
  content: Pick<ContentService, "getItem">;
  reviews: Pick<ReviewsService, "create">;
  calendar: CalendarService;
  /** Every channel as the API shows it. */
  listChannels(): Promise<Channel[]>;
}

/**
 * The owner acting through their token. Only the owner's tokens carry `mcp:admin`, and the
 * registry checks the scope; the owner is checked here as well, so a token that kept the scope by
 * mistake still cannot decide or schedule anything.
 *
 * The moves are the owner's own, so the actor is the owner as a user: the transition table lets
 * users approve and schedule, and it stays closed to tokens. The registry's audit row of the call
 * names the token and the records it changed.
 */
function ownerActor(caller: McpCaller, what: string): PipelineActor {
  if (caller.token.user.role !== "owner") {
    throw new McpToolError("forbidden", `Only the owner can ${what}.`);
  }
  const userId = caller.token.user.id;
  return { kind: "user", id: userId, userId, ip: caller.ip };
}

function postAudit(post: ScheduledPost) {
  return { postId: post.id, itemId: post.itemId, channelId: post.channelId };
}

function postSummary(verb: string, post: ScheduledPost): string {
  return (
    `${verb} post ${post.id} of item ${post.itemId} on channel ${post.channelId} ` +
    `for ${post.scheduledAt}; it is ${post.status}${post.dryRun ? " (dry run)" : ""}.`
  );
}

/**
 * `content.review`, `channel.list` and the `calendar.*` tools that schedule, move and cancel
 * posts: the owner's review queue and calendar, through the same services as the web app.
 */
export function createOwnerTools(deps: OwnerToolsDeps): ToolDefinition[] {
  const { content, reviews, calendar } = deps;

  async function itemProject(itemId: string): Promise<string | null> {
    return (await content.getItem(itemId))?.projectId ?? null;
  }

  const review = defineTool(ownerTools["content.review"], {
    resolveProject: (input) => itemProject(input.itemId),
    async handler(input, { caller }) {
      const actor = ownerActor(caller, "review items");
      const { itemId, ...decision } = input;
      const result = await reviews.create(itemId, decision, actor);
      if (result === null) {
        throw new McpToolError("not_found", "No content item has that id.");
      }
      return {
        reviewId: result.review.id,
        itemId: result.item.id,
        decision: result.review.decision,
        state: result.item.state,
      };
    },
    summary: ({ reviewId, itemId, decision, state }) =>
      `Review ${reviewId}: ${decision} on item ${itemId}; the item is now in ${state}.`,
    auditData: ({ reviewId, itemId, decision, state }) => ({ reviewId, itemId, decision, state }),
  });

  const listChannels = defineTool(ownerTools["channel.list"], {
    async handler(_input, { caller }) {
      ownerActor(caller, "list channels");
      return { channels: await deps.listChannels() };
    },
    summary: ({ channels }) => {
      const live = channels.filter((channel) => !channel.dryRun).length;
      return `${channels.length} channel${channels.length === 1 ? "" : "s"}, ${live} publishing live.`;
    },
  });

  const listPosts = defineTool(ownerTools["calendar.list_posts"], {
    resolveProject: async (input) => input.projectId,
    async handler(input, { caller }) {
      ownerActor(caller, "read the calendar");
      return calendar.get({
        from: input.from,
        to: input.to,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.channelIds === undefined ? {} : { channelIds: input.channelIds }),
      });
    },
    summary: ({ posts, slots }) => {
      const open = slots.filter((slot) => slot.postId === undefined).length;
      return `${posts.length} post${posts.length === 1 ? "" : "s"}, ${open} open slot${open === 1 ? "" : "s"}.`;
    },
  });

  const schedulePost = defineTool(ownerTools["calendar.schedule_post"], {
    resolveProject: (input) => itemProject(input.itemId),
    async handler(input, { caller }) {
      const actor = ownerActor(caller, "schedule posts");
      return { post: await calendar.create(input, actor) };
    },
    summary: ({ post }) => postSummary("Scheduled", post),
    auditData: ({ post }) => postAudit(post),
  });

  const reschedulePost = defineTool(ownerTools["calendar.reschedule_post"], {
    async handler(input, { caller }) {
      const actor = ownerActor(caller, "reschedule posts");
      const { postId, ...move } = input;
      return { post: await calendar.reschedule(postId, move, actor) };
    },
    summary: ({ post }) => postSummary("Moved", post),
    auditData: ({ post }) => postAudit(post),
  });

  const cancelPost = defineTool(ownerTools["calendar.cancel_post"], {
    async handler(input, { caller }) {
      const actor = ownerActor(caller, "cancel posts");
      return { post: await calendar.cancel(input.postId, actor) };
    },
    summary: ({ post }) => `Cancelled post ${post.id} of item ${post.itemId}.`,
    auditData: ({ post }) => postAudit(post),
  });

  return [review, listChannels, listPosts, schedulePost, reschedulePost, cancelPost];
}
