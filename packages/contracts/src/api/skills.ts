import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { PipelineStateSchema, SkillKindSchema } from "../enums";
import { ProgressHealthSchema, ProgressStepKeySchema } from "../pipeline/progress";
import {
  SkillChecksumSchema,
  SkillFileSchema,
  SkillNameSchema,
  SkillVersionNumberSchema,
} from "../pipeline/skills";

/** A skill with its latest version. `description` comes from its `skill.json`. */
export const SkillSummarySchema = z.object({
  id: IdSchema,
  name: SkillNameSchema,
  kind: SkillKindSchema,
  description: z.string().nullable(),
  latestVersion: SkillVersionNumberSchema,
  checksum: SkillChecksumSchema,
  updatedAt: TimestampSchema,
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

/** One published version, without its files. */
export const SkillVersionSummarySchema = z.object({
  skillId: IdSchema,
  name: SkillNameSchema,
  kind: SkillKindSchema,
  version: SkillVersionNumberSchema,
  /** SHA-256 of `skillChecksumInput(files)`. */
  checksum: SkillChecksumSchema,
  changelog: z.string().nullable(),
  fileCount: z.number().int().min(1),
  /** Total UTF-8 size of the file contents. */
  bytes: z.number().int().min(0),
  /** The user who published it, or null when it came from an MCP token without a user session. */
  publishedByUser: IdSchema.nullable(),
  publishedAt: TimestampSchema,
});
export type SkillVersionSummary = z.infer<typeof SkillVersionSummarySchema>;

/** One published version with its files. */
export const SkillVersionDetailSchema = SkillVersionSummarySchema.extend({
  files: z.array(SkillFileSchema),
});
export type SkillVersionDetail = z.infer<typeof SkillVersionDetailSchema>;

/** `GET /api/skills/:name`: the latest version unless `version` names one. */
export const GetSkillQuerySchema = z.object({
  version: z.coerce.number().int().min(1).optional(),
});
export type GetSkillQuery = z.infer<typeof GetSkillQuerySchema>;

/** The registry entry of a skill name seen in production progress. */
export const SkillRegistryRefSchema = z.object({
  kind: SkillKindSchema,
  description: z.string().nullable(),
  latestVersion: SkillVersionNumberSchema,
});
export type SkillRegistryRef = z.infer<typeof SkillRegistryRefSchema>;

/**
 * How a skill or tool name was used in reported production progress (`content_progress` steps).
 * `name` is the text the producer reported, so it need not be a registry name.
 */
export const ProgressNameUsageSchema = z.object({
  name: z.string(),
  /** Items with at least one step that used the name. */
  items: z.number().int().min(0),
  /** The steps it was used in, in step order. */
  steps: z.array(ProgressStepKeySchema),
  /** The latest finish or start time of those steps, else the latest report of their items. */
  lastUsedAt: TimestampSchema,
});
export type ProgressNameUsage = z.infer<typeof ProgressNameUsageSchema>;

/** A skill name used in production progress, with its registry entry when there is one. */
export const SkillUsageSchema = ProgressNameUsageSchema.extend({
  registry: SkillRegistryRefSchema.nullable(),
});
export type SkillUsage = z.infer<typeof SkillUsageSchema>;

/** A tool (a command such as `cm say`) used in production progress. */
export const ToolUsageSchema = ProgressNameUsageSchema;
export type ToolUsage = z.infer<typeof ToolUsageSchema>;

/** A recipe a format of the workspace names in its current rules (`rules.recipe`). */
export const FormatRecipeUsageSchema = z.object({
  formatId: IdSchema,
  formatName: z.string(),
  name: SkillNameSchema,
  /** The pinned version, or null for the latest. */
  version: SkillVersionNumberSchema.nullable(),
  registry: SkillRegistryRefSchema.nullable(),
});
export type FormatRecipeUsage = z.infer<typeof FormatRecipeUsageSchema>;

/**
 * `GET /api/workspaces/:workspaceId/skills`: the skills and tools the workspace's reported
 * progress used, most recently used first, and the recipes its formats name.
 */
export const WorkspaceSkillsSchema = z.object({
  workspaceId: IdSchema,
  skills: z.array(SkillUsageSchema),
  tools: z.array(ToolUsageSchema),
  recipes: z.array(FormatRecipeUsageSchema),
});
export type WorkspaceSkills = z.infer<typeof WorkspaceSkillsSchema>;

/** One item whose reported progress used a skill, for `GET /api/skills/:name/usage`. */
export const SkillUsageItemSchema = z.object({
  itemId: IdSchema,
  workspaceId: IdSchema,
  workspaceSlug: z.string(),
  workspaceName: z.string(),
  title: z.string(),
  itemState: PipelineStateSchema,
  /** The item's current production step and health (see `progressStage`). */
  stage: ProgressStepKeySchema,
  health: ProgressHealthSchema,
  /** The steps of this item that used the skill, in step order. */
  steps: z.array(ProgressStepKeySchema),
  lastUsedAt: TimestampSchema,
});
export type SkillUsageItem = z.infer<typeof SkillUsageItemSchema>;
