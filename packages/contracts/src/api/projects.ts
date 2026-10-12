import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { ProjectStatusSchema } from "../enums";
import { SlugSchema } from "../util/slug";

export const PROJECT_NAME_MAX_LENGTH = 120;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 2_000;

export const ProjectNameSchema = z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH);
export const ProjectDescriptionSchema = z.string().trim().max(PROJECT_DESCRIPTION_MAX_LENGTH);

export const ProjectSchema = z.object({
  id: IdSchema,
  slug: SlugSchema,
  name: z.string(),
  description: z.string().nullable(),
  status: ProjectStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** When `slug` is omitted the API derives it from the name and adds `-2`, `-3`, … on collision. */
export const CreateProjectSchema = z.object({
  name: ProjectNameSchema,
  slug: SlugSchema.optional(),
  description: ProjectDescriptionSchema.optional(),
});
export type CreateProject = z.infer<typeof CreateProjectSchema>;

/** Partial update. The slug never changes; archiving has its own route. */
export const UpdateProjectSchema = z
  .object({
    name: ProjectNameSchema.optional(),
    description: ProjectDescriptionSchema.nullable().optional(),
  })
  .refine((update) => update.name !== undefined || update.description !== undefined, {
    message: "Provide at least one field to update",
  });
export type UpdateProject = z.infer<typeof UpdateProjectSchema>;

export const ListProjectsQuerySchema = z.object({
  status: ProjectStatusSchema.optional(),
});
export type ListProjectsQuery = z.infer<typeof ListProjectsQuerySchema>;
