import { z } from "zod";
import { CreateProjectSchema, ProjectSchema } from "../api/projects";
import { ProjectStatusSchema, type TokenScope } from "../enums";

/** Contract of one MCP tool: its name, the scope a token needs, and its input and output. */
export interface McpToolContract {
  readonly name: string;
  readonly scope: TokenScope;
  readonly description: string;
  readonly input: z.ZodObject;
  readonly output: z.ZodObject;
}

const count = z.number().int().min(0);

export const ProjectCreateInputSchema = CreateProjectSchema;
export type ProjectCreateInput = z.infer<typeof ProjectCreateInputSchema>;

export const ProjectCreateOutputSchema = z.object({
  project: ProjectSchema.pick({ id: true, slug: true, name: true, description: true }).extend({
    /** Link to the project in the web app. */
    url: z.url(),
  }),
});
export type ProjectCreateOutput = z.infer<typeof ProjectCreateOutputSchema>;

export const ProjectGetInputSchema = z.object({
  idOrSlug: z.string().trim().min(1).max(64),
});
export type ProjectGetInput = z.infer<typeof ProjectGetInputSchema>;

/** Counts of what a project holds. `kbEntries` and `items` stay 0 until those features exist. */
export const ProjectStatsSchema = z.object({
  conversations: count,
  kbEntries: count,
  items: count,
});
export type ProjectStats = z.infer<typeof ProjectStatsSchema>;

export const ProjectGetOutputSchema = z.object({
  project: ProjectSchema,
  stats: ProjectStatsSchema,
});
export type ProjectGetOutput = z.infer<typeof ProjectGetOutputSchema>;

export const ProjectListInputSchema = z.object({
  status: ProjectStatusSchema.optional(),
});
export type ProjectListInput = z.infer<typeof ProjectListInputSchema>;

export const ProjectListOutputSchema = z.object({
  projects: z.array(ProjectSchema),
});
export type ProjectListOutput = z.infer<typeof ProjectListOutputSchema>;

/** The M1 project tools served on `/mcp`. */
export const projectTools = {
  "project.create": {
    name: "project.create",
    scope: "mcp:write",
    description:
      "Create a project. The slug is derived from the name unless given. Returns the project and its link.",
    input: ProjectCreateInputSchema,
    output: ProjectCreateOutputSchema,
  },
  "project.get": {
    name: "project.get",
    scope: "mcp:read",
    description: "Get a project by id or slug, with counts of its conversations and content.",
    input: ProjectGetInputSchema,
    output: ProjectGetOutputSchema,
  },
  "project.list": {
    name: "project.list",
    scope: "mcp:read",
    description: "List projects, optionally filtered by status.",
    input: ProjectListInputSchema,
    output: ProjectListOutputSchema,
  },
} as const satisfies Record<string, McpToolContract>;

export type ProjectToolName = keyof typeof projectTools;
