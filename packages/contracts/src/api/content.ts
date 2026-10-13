import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import {
  ContentActionSchema,
  ContentCreatedViaSchema,
  JobTypeSchema,
  PIPELINE_STATES,
  PipelineStateSchema,
  VersionCreatedViaSchema,
} from "../enums";
import { CAPTION_MAX_LENGTH, ScriptSchema, StoryboardSchema } from "../pipeline/artifacts";
import { ProduceTargetSchema } from "../pipeline/transitions";
import { CursorPageQuerySchema, csvEnumQuerySchema } from "./common";
import { JobSummarySchema } from "./jobs";

export const CONTENT_TITLE_MAX_LENGTH = 200;
export const CONTENT_PITCH_MAX_LENGTH = 2_000;
export const CONTENT_TOPIC_MAX_LENGTH = 200;
export const VERSION_NOTES_MAX_LENGTH = 4_000;
export const CONTENT_SEARCH_MAX_LENGTH = 200;

export const ContentTitleSchema = z.string().trim().min(1).max(CONTENT_TITLE_MAX_LENGTH);
export const ContentPitchSchema = z.string().trim().max(CONTENT_PITCH_MAX_LENGTH);
export const ContentTopicSchema = z.string().trim().min(1).max(CONTENT_TOPIC_MAX_LENGTH);
export const VersionNotesSchema = z.string().trim().max(VERSION_NOTES_MAX_LENGTH);

/** The last production failure of an item, cleared by the next successful step. */
export const ContentItemErrorSchema = z.object({
  jobId: IdSchema,
  jobType: JobTypeSchema,
  code: z.string().min(1).max(64),
  message: z.string().max(2_000),
  at: TimestampSchema,
});
export type ContentItemError = z.infer<typeof ContentItemErrorSchema>;

/** A content item as listed and sent in live events. */
export const ContentItemSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  seriesId: IdSchema.nullable(),
  title: z.string(),
  pitch: z.string().nullable(),
  topic: z.string().nullable(),
  state: PipelineStateSchema,
  /** Every item has a version from the start: version 1 is the bare idea. */
  currentVersionId: IdSchema,
  versionNo: z.number().int().min(1),
  /** The current version's render length, when it has one. */
  durationMs: z.number().int().min(0).nullable(),
  /** The current version's poster, when it has one. */
  posterAssetId: IdSchema.nullable(),
  /** When the item should be published. */
  targetAt: TimestampSchema.nullable(),
  /** Where autopilot stops; null when autopilot is off. */
  autopilotTarget: ProduceTargetSchema.nullable(),
  lastError: ContentItemErrorSchema.nullable(),
  createdVia: ContentCreatedViaSchema,
  createdBy: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
});
export type ContentItem = z.infer<typeof ContentItemSchema>;

/** A version without its script and storyboard, as listed in the version timeline. */
export const ContentVersionSummarySchema = z.object({
  id: IdSchema,
  itemId: IdSchema,
  versionNo: z.number().int().min(1),
  /** The state the item entered with this version. */
  stage: PipelineStateSchema,
  parentVersionId: IdSchema.nullable(),
  /** The format version it was produced with. */
  formatVersionId: IdSchema.nullable(),
  hasScript: z.boolean(),
  hasStoryboard: z.boolean(),
  voiceAssetId: IdSchema.nullable(),
  renderAssetId: IdSchema.nullable(),
  posterAssetId: IdSchema.nullable(),
  notes: z.string().nullable(),
  createdVia: VersionCreatedViaSchema,
  createdByUser: IdSchema.nullable(),
  /** The job whose result this version is; one version per job at most. */
  jobId: IdSchema.nullable(),
  createdAt: TimestampSchema,
});
export type ContentVersionSummary = z.infer<typeof ContentVersionSummarySchema>;

/** One immutable version with its artifacts. */
export const ContentVersionSchema = ContentVersionSummarySchema.extend({
  script: ScriptSchema.nullable(),
  storyboard: StoryboardSchema.nullable(),
  /** The post caption; when null, the script's caption is used. */
  caption: z.string().nullable(),
});
export type ContentVersion = z.infer<typeof ContentVersionSchema>;

/** An item with its current version, its version timeline (newest first) and its active job. */
export const ContentItemDetailSchema = z.object({
  item: ContentItemSchema,
  currentVersion: ContentVersionSchema,
  versions: z.array(ContentVersionSummarySchema),
  /** The production job queued or running for the item, if any. */
  activeJob: JobSummarySchema.nullable(),
});
export type ContentItemDetail = z.infer<typeof ContentItemDetailSchema>;

/**
 * `GET /api/content`: most recently updated first, cursor-paginated. Without `states`, archived
 * items are left out. `targetFrom` and `targetTo` bound `targetAt` (inclusive); `q` searches
 * titles and pitches.
 */
export const ListContentQuerySchema = CursorPageQuerySchema.extend({
  projectId: IdSchema.optional(),
  states: csvEnumQuerySchema(PIPELINE_STATES).optional(),
  seriesId: IdSchema.optional(),
  q: z.string().trim().min(1).max(CONTENT_SEARCH_MAX_LENGTH).optional(),
  targetFrom: TimestampSchema.optional(),
  targetTo: TimestampSchema.optional(),
}).refine(
  (query) =>
    query.targetFrom === undefined ||
    query.targetTo === undefined ||
    Date.parse(query.targetFrom) <= Date.parse(query.targetTo),
  { message: "The range must not end before it starts", path: ["targetTo"] },
);
export type ListContentQuery = z.infer<typeof ListContentQuerySchema>;

/** Creates an idea (state `idea`, version 1). The series must belong to the project. */
export const CreateContentItemRequestSchema = z.object({
  title: ContentTitleSchema,
  pitch: ContentPitchSchema.optional(),
  topic: ContentTopicSchema.optional(),
  seriesId: IdSchema.optional(),
  targetAt: TimestampSchema.optional(),
});
export type CreateContentItemRequest = z.infer<typeof CreateContentItemRequestSchema>;

/** Changes the title or pitch. Neither creates a version. */
export const UpdateContentItemRequestSchema = z
  .object({
    title: ContentTitleSchema.optional(),
    pitch: ContentPitchSchema.nullable().optional(),
  })
  .refine((update) => update.title !== undefined || update.pitch !== undefined, {
    message: "Provide at least one field to update",
  });
export type UpdateContentItemRequest = z.infer<typeof UpdateContentItemRequestSchema>;

/**
 * Writes a new version on top of `baseVersionId`, which must be the current version (otherwise
 * `409 conflict`). Fields left out are copied forward. A changed script clears the voice, render
 * and poster; a changed storyboard clears the render and poster; a new `voiceAssetId` (a ready
 * voice take of the same item) clears the render. The item's state follows from
 * `PIPELINE_TRANSITIONS`.
 */
export const EditVersionRequestSchema = z
  .object({
    baseVersionId: IdSchema,
    script: ScriptSchema.optional(),
    storyboard: StoryboardSchema.optional(),
    caption: z.string().trim().max(CAPTION_MAX_LENGTH).nullable().optional(),
    voiceAssetId: IdSchema.optional(),
    notes: VersionNotesSchema.nullable().optional(),
  })
  .refine(
    (edit) =>
      Object.entries(edit).some(([key, value]) => key !== "baseVersionId" && value !== undefined),
    { message: "Provide at least one change" },
  );
export type EditVersionRequest = z.infer<typeof EditVersionRequestSchema>;

/** The item after the edit and the version it now points at. */
export const EditVersionResponseSchema = z.object({
  item: ContentItemSchema,
  version: ContentVersionSchema,
});
export type EditVersionResponse = z.infer<typeof EditVersionResponseSchema>;

/**
 * Starts production work. `through` is only for `produce` (default `review`). Answers `409
 * job_in_progress` while another production job of the item is active, `422 missing_artifact`
 * when the step's input is missing and `422 voice_not_configured` for a voice without a format
 * voice.
 */
export const ContentActionRequestSchema = z
  .object({
    action: ContentActionSchema,
    through: ProduceTargetSchema.optional(),
  })
  .refine((request) => request.through === undefined || request.action === "produce", {
    message: "Only produce takes a target",
    path: ["through"],
  });
export type ContentActionRequest = z.infer<typeof ContentActionRequestSchema>;
