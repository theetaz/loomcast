import { type AnalyticsPost, analyticsTools, RESEARCH_LIMITS } from "@loomcast/contracts";
import type { AnalyticsService } from "../../analytics/service";
import type { WorkspacesService } from "../../workspaces/service";
import { defineTool, McpToolError, type ToolDefinition } from "./registry";

export interface AnalyticsToolsDeps {
  analytics: Pick<AnalyticsService, "listPosts" | "post" | "postWorkspace">;
  workspaces: Pick<WorkspacesService, "get">;
}

const SUMMARY_LIMIT = 50;

function number(value: number | null | undefined): string {
  return value === null || value === undefined ? "?" : value.toLocaleString("en-US");
}

function describePost(post: AnalyticsPost): string {
  const metrics =
    post.metrics === null
      ? "no metrics yet"
      : `${number(post.metrics.views)} views, ${number(post.metrics.reach)} reach, ` +
        `${number(post.metrics.likes)} likes, ${number(post.metrics.comments)} comments, ` +
        `${number(post.metrics.shares)} shares, ${number(post.metrics.saves)} saves`;
  return (
    `- ${post.postId} "${post.title}" on ${post.platform} ${post.channelName}, ` +
    `${post.publishedAt}: ${metrics}`
  );
}

/** `analytics.list_posts` and `analytics.post_history`: our own live posts and their captures. */
export function createAnalyticsTools(deps: AnalyticsToolsDeps): ToolDefinition[] {
  const { analytics, workspaces } = deps;

  const listPosts = defineTool(analyticsTools["analytics.list_posts"], {
    async resolveWorkspace(input) {
      if (input.workspace === undefined) return undefined;
      return (await workspaces.get(input.workspace))?.id ?? null;
    },
    async handler(input, ctx) {
      if (input.workspace !== undefined && ctx.workspaceId === null) {
        throw new McpToolError("not_found", "No workspace has that id or slug.");
      }
      const posts = await analytics.listPosts({
        ...(ctx.workspaceId === null ? {} : { workspaceId: ctx.workspaceId }),
        since: input.since,
        limit: input.limit ?? RESEARCH_LIMITS.listDefault,
      });
      return { posts };
    },
    summary: ({ posts }) => {
      if (posts.length === 0) return "No published posts.";
      const lines = posts.slice(0, SUMMARY_LIMIT).map(describePost);
      if (posts.length > SUMMARY_LIMIT) lines.push(`- and ${posts.length - SUMMARY_LIMIT} more`);
      return [`${posts.length} published posts, newest first:`, ...lines].join("\n");
    },
  });

  const postHistory = defineTool(analyticsTools["analytics.post_history"], {
    resolveWorkspace: (input) => analytics.postWorkspace(input.postId),
    async handler(input, ctx) {
      const found = ctx.workspaceId === null ? null : await analytics.post(input.postId);
      if (found === null) {
        throw new McpToolError("not_found", "No published post has that id.");
      }
      return found;
    },
    summary: ({ post, history, nextCaptureAt }) => {
      const lines = history.map(
        (capture) =>
          `- ${capture.capturedAt}: ${number(capture.views)} views, ${number(capture.reach)} reach, ` +
          `${number(capture.likes)} likes, ${number(capture.comments)} comments, ` +
          `${number(capture.shares)} shares, ${number(capture.saves)} saves, ` +
          `avg watch ${capture.avgWatchMs === null ? "?" : `${capture.avgWatchMs} ms`}`,
      );
      return [
        `Post ${post.postId} "${post.title}" on ${post.platform}, published ${post.publishedAt}: ` +
          `${history.length} captures${nextCaptureAt === null ? "" : `, next at ${nextCaptureAt}`}.`,
        ...lines,
      ].join("\n");
    },
  });

  return [listPosts, postHistory];
}
