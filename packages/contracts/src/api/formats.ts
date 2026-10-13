import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { FormatRulesSchema } from "../pipeline/format-rules";
import { SlugSchema } from "../util/slug";

export const FORMAT_NAME_MAX_LENGTH = 120;

export const FormatNameSchema = z.string().trim().min(1).max(FORMAT_NAME_MAX_LENGTH);

/** One immutable version of a format's rules. Versions count up from 1. */
export const FormatVersionSchema = z.object({
  id: IdSchema,
  formatId: IdSchema,
  versionNo: z.number().int().min(1),
  rules: FormatRulesSchema,
  createdBy: IdSchema.nullable(),
  createdAt: TimestampSchema,
});
export type FormatVersion = z.infer<typeof FormatVersionSchema>;

/** A format of a project, with its current version. */
export const FormatSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  name: z.string(),
  slug: SlugSchema,
  currentVersion: FormatVersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
});
export type Format = z.infer<typeof FormatSchema>;

/**
 * Creates a format with version 1. Without `rules` it starts from `DEFAULT_FORMAT_RULES`; without
 * `slug` the API derives one from the name, unique within the project.
 */
export const CreateFormatRequestSchema = z.object({
  name: FormatNameSchema,
  slug: SlugSchema.optional(),
  rules: FormatRulesSchema.optional(),
});
export type CreateFormatRequest = z.infer<typeof CreateFormatRequestSchema>;

/**
 * Every update stores a new version, even a rename. `baseVersionId` is the version the client
 * edited; when it is no longer current the API answers `409 conflict` and changes nothing.
 */
export const UpdateFormatRequestSchema = z
  .object({
    baseVersionId: IdSchema,
    name: FormatNameSchema.optional(),
    rules: FormatRulesSchema.optional(),
  })
  .refine((update) => update.name !== undefined || update.rules !== undefined, {
    message: "Provide at least one field to update",
  });
export type UpdateFormatRequest = z.infer<typeof UpdateFormatRequestSchema>;
