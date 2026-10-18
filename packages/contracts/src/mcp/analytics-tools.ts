import { z } from "zod";
import { PostAnalyticsSchema, PostPerformanceSchema } from "../api/analytics";
import { IdSchema, TimestampSchema } from "../common";
import { RESEARCH_LIMITS } from "../research/research";
import type { McpToolContract } from "./contract";
import { McpWorkspaceRefSchema } from "./research-tools";

export const AnalyticsListPostsInputSchema = z.object({
  workspace: McpWorkspaceRefSchema.optional().describe(
    "The workspace's id or slug; left out, posts of every workspace.",
  ),
  since: TimestampSchema.optional().describe("Only posts published at or after this time."),
  limit: z.number().int().min(1).max(RESEARCH_LIMITS.listMax).optional(),
});
export type AnalyticsListPostsInput = z.infer<typeof AnalyticsListPostsInputSchema>;

/** A live post with its latest capture, its channel's name and its item's topic. */
export const AnalyticsPostSchema = PostPerformanceSchema.extend({
  channelName: z.string(),
  topic: z.string().nullable(),
});
export type AnalyticsPost = z.infer<typeof AnalyticsPostSchema>;

export const AnalyticsListPostsOutputSchema = z.object({
  posts: z.array(AnalyticsPostSchema),
});
export type AnalyticsListPostsOutput = z.infer<typeof AnalyticsListPostsOutputSchema>;

export const AnalyticsPostHistoryInputSchema = z.object({
  postId: IdSchema.describe("A post id from analytics.list_posts."),
});
export type AnalyticsPostHistoryInput = z.infer<typeof AnalyticsPostHistoryInputSchema>;

export const AnalyticsPostHistoryOutputSchema = PostAnalyticsSchema;
export type AnalyticsPostHistoryOutput = z.infer<typeof AnalyticsPostHistoryOutputSchema>;

/**
 * The workspace's own post analytics on `/mcp`, read-only. Only live posts count: published and not
 * dry-run.
 */
export const analyticsTools = {
  "analytics.list_posts": {
    name: "analytics.list_posts",
    scope: "mcp:read",
    jobTokens: "allow",
    workspaceBinding: "input",
    description: `List our own published posts, newest first (limit default ${RESEARCH_LIMITS.listDefault}, at most ${RESEARCH_LIMITS.listMax}), each with its item title and topic, channel and platform, permalink, publish time and latest captured metrics (views, reach, likes, comments, shares, saves and avgWatchMs, each null when the platform does not report it; metrics is null before the first capture). Dry-run posts are left out.`,
    input: AnalyticsListPostsInputSchema,
    output: AnalyticsListPostsOutputSchema,
  },
  "analytics.post_history": {
    name: "analytics.post_history",
    scope: "mcp:read",
    jobTokens: "allow",
    workspaceBinding: "input",
    description:
      "Every metrics capture of one of our published posts, oldest first (captures are running totals taken 1 h, 6 h, 24 h, 72 h, 7, 14 and 30 days after publishing), with when the next capture is due.",
    input: AnalyticsPostHistoryInputSchema,
    output: AnalyticsPostHistoryOutputSchema,
  },
} as const satisfies Record<string, McpToolContract>;

export type AnalyticsToolName = keyof typeof analyticsTools;
