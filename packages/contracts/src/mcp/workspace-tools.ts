import { z } from "zod";
import { CreateWorkspaceSchema, WorkspaceSchema } from "../api/workspaces";
import { WorkspaceStatusSchema } from "../enums";
import type { McpToolContract } from "./contract";

const count = z.number().int().min(0);

export const WorkspaceCreateInputSchema = CreateWorkspaceSchema;
export type WorkspaceCreateInput = z.infer<typeof WorkspaceCreateInputSchema>;

export const WorkspaceCreateOutputSchema = z.object({
  workspace: WorkspaceSchema.pick({ id: true, slug: true, name: true, description: true }).extend({
    /** Link to the workspace in the web app. */
    url: z.url(),
  }),
});
export type WorkspaceCreateOutput = z.infer<typeof WorkspaceCreateOutputSchema>;

export const WorkspaceGetInputSchema = z.object({
  idOrSlug: z.string().trim().min(1).max(64),
});
export type WorkspaceGetInput = z.infer<typeof WorkspaceGetInputSchema>;

/** Counts of what a workspace holds. `items` stays 0 until content items exist. */
export const WorkspaceStatsSchema = z.object({
  conversations: count,
  kbEntries: count,
  items: count,
});
export type WorkspaceStats = z.infer<typeof WorkspaceStatsSchema>;

export const WorkspaceGetOutputSchema = z.object({
  workspace: WorkspaceSchema,
  stats: WorkspaceStatsSchema,
});
export type WorkspaceGetOutput = z.infer<typeof WorkspaceGetOutputSchema>;

export const WorkspaceListInputSchema = z.object({
  status: WorkspaceStatusSchema.optional(),
});
export type WorkspaceListInput = z.infer<typeof WorkspaceListInputSchema>;

export const WorkspaceListOutputSchema = z.object({
  workspaces: z.array(WorkspaceSchema),
});
export type WorkspaceListOutput = z.infer<typeof WorkspaceListOutputSchema>;

/**
 * The workspace tools served on `/mcp`. Job tokens may read workspaces but never create one; with a
 * job token, `workspace.list` returns only the job's workspace.
 */
export const workspaceTools = {
  "workspace.create": {
    name: "workspace.create",
    scope: "mcp:write",
    jobTokens: "deny",
    workspaceBinding: "none",
    description:
      "Create a workspace. The slug is derived from the name unless given. Returns the workspace and its link.",
    input: WorkspaceCreateInputSchema,
    output: WorkspaceCreateOutputSchema,
  },
  "workspace.get": {
    name: "workspace.get",
    scope: "mcp:read",
    jobTokens: "allow",
    workspaceBinding: "input",
    description: "Get a workspace by id or slug, with counts of its conversations and content.",
    input: WorkspaceGetInputSchema,
    output: WorkspaceGetOutputSchema,
  },
  "workspace.list": {
    name: "workspace.list",
    scope: "mcp:read",
    jobTokens: "allow",
    workspaceBinding: "none",
    description: "List workspaces, optionally filtered by status.",
    input: WorkspaceListInputSchema,
    output: WorkspaceListOutputSchema,
  },
} as const satisfies Record<string, McpToolContract>;

export type WorkspaceToolName = keyof typeof workspaceTools;
