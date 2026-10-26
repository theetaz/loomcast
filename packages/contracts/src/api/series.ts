import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { SeriesStatusSchema } from "../enums";
import { SlugSchema } from "../util/slug";

export const SERIES_NAME_MAX_LENGTH = 120;

export const SeriesNameSchema = z.string().trim().min(1).max(SERIES_NAME_MAX_LENGTH);

/** A series of a workspace. Its items follow the rules of its format. */
export const SeriesSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  name: z.string(),
  slug: SlugSchema,
  formatId: IdSchema,
  status: SeriesStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
});
export type Series = z.infer<typeof SeriesSchema>;

/** The format must belong to the same workspace. Without `slug` the API derives one. */
export const CreateSeriesRequestSchema = z.object({
  name: SeriesNameSchema,
  slug: SlugSchema.optional(),
  formatId: IdSchema,
});
export type CreateSeriesRequest = z.infer<typeof CreateSeriesRequestSchema>;

/** Partial update. Pausing, resuming and archiving have their own routes. */
export const UpdateSeriesRequestSchema = z
  .object({
    name: SeriesNameSchema.optional(),
    formatId: IdSchema.optional(),
  })
  .refine((update) => update.name !== undefined || update.formatId !== undefined, {
    message: "Provide at least one field to update",
  });
export type UpdateSeriesRequest = z.infer<typeof UpdateSeriesRequestSchema>;

/** `GET /api/workspaces/:workspaceId/series`: every series unless `status` narrows it. */
export const ListSeriesQuerySchema = z.object({
  status: SeriesStatusSchema.optional(),
});
export type ListSeriesQuery = z.infer<typeof ListSeriesQuerySchema>;
