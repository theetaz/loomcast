import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { WorkspaceColorSchema, WorkspaceStatusSchema } from "../enums";
import { TimeZoneSchema } from "../pipeline/format-rules";
import { SlugSchema } from "../util/slug";

export const WORKSPACE_NAME_MAX_LENGTH = 120;
export const WORKSPACE_DESCRIPTION_MAX_LENGTH = 2_000;

export const WorkspaceNameSchema = z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH);
export const WorkspaceDescriptionSchema = z.string().trim().max(WORKSPACE_DESCRIPTION_MAX_LENGTH);

/** Largest workspace icon the API stores, in bytes. The web app resizes images to 256×256 first. */
export const WORKSPACE_ICON_MAX_BYTES = 256 * 1024;

/** Image types a workspace icon may have. SVG is refused: it can carry script. */
export const WORKSPACE_ICON_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export const WorkspaceIconMimeSchema = z.enum(WORKSPACE_ICON_MIMES);
export type WorkspaceIconMime = (typeof WORKSPACE_ICON_MIMES)[number];

/** Longest same-origin icon path the API hands out (`workspaceIconPath`). */
const WORKSPACE_ICON_PATH_MAX_LENGTH = 200;

export const WorkspaceSchema = z.object({
  id: IdSchema,
  slug: SlugSchema,
  name: z.string(),
  description: z.string().nullable(),
  status: WorkspaceStatusSchema,
  color: WorkspaceColorSchema,
  /** The icon as the web app loads it, a path on the API that changes with the image; null without one. */
  iconUrl: z
    .string()
    .max(WORKSPACE_ICON_PATH_MAX_LENGTH)
    .regex(/^\/api\/workspaces\/[0-9a-f-]{36}\/icon\?v=\d+$/)
    .nullable(),
  /** The time zone the workspace's calendar shows by default, an IANA time zone. */
  timeZone: TimeZoneSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** When `slug` is omitted the API derives it from the name and adds `-2`, `-3`, … on collision. */
export const CreateWorkspaceSchema = z.object({
  name: WorkspaceNameSchema,
  slug: SlugSchema.optional(),
  description: WorkspaceDescriptionSchema.optional(),
  color: WorkspaceColorSchema.optional(),
  timeZone: TimeZoneSchema.optional(),
});
export type CreateWorkspace = z.infer<typeof CreateWorkspaceSchema>;

/** Partial update. The slug never changes; archiving and the icon have their own routes. */
export const UpdateWorkspaceSchema = z
  .object({
    name: WorkspaceNameSchema.optional(),
    description: WorkspaceDescriptionSchema.nullable().optional(),
    color: WorkspaceColorSchema.optional(),
    timeZone: TimeZoneSchema.optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    message: "Provide at least one field to update",
  });
export type UpdateWorkspace = z.infer<typeof UpdateWorkspaceSchema>;

export const ListWorkspacesQuerySchema = z.object({
  status: WorkspaceStatusSchema.optional(),
});
export type ListWorkspacesQuery = z.infer<typeof ListWorkspacesQuerySchema>;

/**
 * A new icon: the image as base64 (at most `WORKSPACE_ICON_MAX_BYTES` once decoded), or a connected
 * channel of the workspace whose profile picture the API copies.
 */
export const SetWorkspaceIconSchema = z.union([
  z.object({
    mime: WorkspaceIconMimeSchema,
    data: z.base64().max(Math.ceil(WORKSPACE_ICON_MAX_BYTES / 3) * 4),
  }),
  z.object({ fromChannelId: IdSchema }),
]);
export type SetWorkspaceIcon = z.infer<typeof SetWorkspaceIconSchema>;
