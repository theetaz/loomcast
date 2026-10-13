import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { SkillKindSchema } from "../enums";
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
