import { z } from "zod";
import {
  AssetDetailSchema,
  AssetSchema,
  AssetUrlQuerySchema,
  checkUploadFile,
  FinalizeAssetRequestSchema,
  UploadFileFields,
  UploadInstructionsSchema,
} from "../api/assets";
import {
  ContentItemSchema,
  ContentPitchSchema,
  ContentTitleSchema,
  ContentTopicSchema,
  ContentVersionSchema,
  VersionNotesSchema,
} from "../api/content";
import { FormatNameSchema } from "../api/formats";
import { IdSchema, TimestampSchema } from "../common";
import { PipelineStateSchema, SkillKindSchema } from "../enums";
import { FormatSnapshotSchema } from "../jobs/registry";
import { CAPTION_MAX_LENGTH, ScriptSchema, StoryboardSchema } from "../pipeline/artifacts";
import { FormatRulesSchema } from "../pipeline/format-rules";
import {
  SKILL_CHANGELOG_MAX_LENGTH,
  SkillChecksumSchema,
  SkillFileSchema,
  SkillFilesSchema,
  SkillNameSchema,
  SkillVersionNumberSchema,
} from "../pipeline/skills";
import type { McpToolContract } from "./contract";

export const FormatGetRulesInputSchema = z.object({
  seriesId: IdSchema,
});
export type FormatGetRulesInput = z.infer<typeof FormatGetRulesInputSchema>;

/** The current rules of a series' format. */
export const FormatGetRulesOutputSchema = z.object({
  formatId: IdSchema,
  name: FormatNameSchema,
  formatVersionId: IdSchema,
  version: z.number().int().min(1),
  rules: FormatRulesSchema,
});
export type FormatGetRulesOutput = z.infer<typeof FormatGetRulesOutputSchema>;

/** A new idea in a project, optionally in one of its series. */
export const ContentCreateIdeaInputSchema = z.object({
  projectId: IdSchema,
  seriesId: IdSchema.optional(),
  title: ContentTitleSchema,
  pitch: ContentPitchSchema.refine((pitch) => pitch.length > 0, {
    message: "Say what the video is about",
  }),
  topic: ContentTopicSchema.optional(),
});
export type ContentCreateIdeaInput = z.infer<typeof ContentCreateIdeaInputSchema>;

export const ContentCreateIdeaOutputSchema = z.object({
  itemId: IdSchema,
});
export type ContentCreateIdeaOutput = z.infer<typeof ContentCreateIdeaOutputSchema>;

/** Without `versionId`, the item's current version. */
export const ContentGetInputSchema = z.object({
  itemId: IdSchema,
  versionId: IdSchema.optional(),
});
export type ContentGetInput = z.infer<typeof ContentGetInputSchema>;

/** The item, one version with its artifacts, and the format it is produced with (if any). */
export const ContentGetOutputSchema = z.object({
  item: ContentItemSchema,
  version: ContentVersionSchema,
  format: FormatSnapshotSchema.nullable(),
});
export type ContentGetOutput = z.infer<typeof ContentGetOutputSchema>;

/**
 * Writes a new version with a script, a storyboard, finished media or a mix. The item's state
 * becomes the version's stage (`stageForArtifacts`); a token never approves. A version that reaches
 * `render` goes on to `review`. The media are ready assets of the item (`content.upload_asset`), so
 * a video finished in the studio can be submitted as it is. A poster comes with a render. With
 * `baseVersionId`, a stale base is refused instead of overwritten.
 */
export const ContentSubmitForReviewInputSchema = z
  .object({
    itemId: IdSchema,
    baseVersionId: IdSchema.optional(),
    script: ScriptSchema.optional(),
    storyboard: StoryboardSchema.optional(),
    voiceAssetId: IdSchema.optional(),
    renderAssetId: IdSchema.optional(),
    posterAssetId: IdSchema.optional(),
    caption: z.string().trim().max(CAPTION_MAX_LENGTH).optional(),
    notes: VersionNotesSchema.optional(),
  })
  .refine(
    (input) =>
      input.script !== undefined ||
      input.storyboard !== undefined ||
      input.voiceAssetId !== undefined ||
      input.renderAssetId !== undefined,
    { message: "Submit a script, a storyboard, a voice take or a render" },
  )
  .refine((input) => input.posterAssetId === undefined || input.renderAssetId !== undefined, {
    message: "A poster comes with its render",
    path: ["posterAssetId"],
  });
export type ContentSubmitForReviewInput = z.infer<typeof ContentSubmitForReviewInputSchema>;

export const ContentSubmitForReviewOutputSchema = z.object({
  versionId: IdSchema,
  versionNo: z.number().int().min(1),
  state: PipelineStateSchema,
});
export type ContentSubmitForReviewOutput = z.infer<typeof ContentSubmitForReviewOutputSchema>;

/** Asks for an upload of an item's file, with the same rules as `assets.createUpload`. */
export const ContentUploadAssetInputSchema = z
  .object({
    itemId: IdSchema,
    ...UploadFileFields,
  })
  .superRefine(checkUploadFile);
export type ContentUploadAssetInput = z.infer<typeof ContentUploadAssetInputSchema>;

/**
 * The asset and where to PUT its bytes. `upload` is null when an identical ready asset already
 * exists; finalize is then not needed.
 */
export const ContentUploadAssetOutputSchema = z.object({
  asset: AssetSchema,
  upload: UploadInstructionsSchema.nullable(),
});
export type ContentUploadAssetOutput = z.infer<typeof ContentUploadAssetOutputSchema>;

export const ContentFinalizeAssetInputSchema = FinalizeAssetRequestSchema.extend({
  assetId: IdSchema,
});
export type ContentFinalizeAssetInput = z.infer<typeof ContentFinalizeAssetInputSchema>;

export const ContentFinalizeAssetOutputSchema = z.object({
  asset: AssetSchema,
});
export type ContentFinalizeAssetOutput = z.infer<typeof ContentFinalizeAssetOutputSchema>;

export const AssetGetUrlInputSchema = AssetUrlQuerySchema.extend({
  assetId: IdSchema,
});
export type AssetGetUrlInput = z.infer<typeof AssetGetUrlInputSchema>;

/** A presigned GET URL and the asset, with a voice take's alignment. */
export const AssetGetUrlOutputSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  expiresAt: TimestampSchema,
  asset: AssetDetailSchema,
});
export type AssetGetUrlOutput = z.infer<typeof AssetGetUrlOutputSchema>;

/** Every skill at its latest version, or one skill (optionally at `version`). */
export const SkillPullInputSchema = z
  .object({
    name: SkillNameSchema.optional(),
    version: SkillVersionNumberSchema.optional(),
  })
  .refine((input) => input.version === undefined || input.name !== undefined, {
    message: "A version needs a skill name",
    path: ["version"],
  });
export type SkillPullInput = z.infer<typeof SkillPullInputSchema>;

export const PulledSkillSchema = z.object({
  name: SkillNameSchema,
  kind: SkillKindSchema,
  version: SkillVersionNumberSchema,
  checksum: SkillChecksumSchema,
  files: z.array(SkillFileSchema),
});
export type PulledSkill = z.infer<typeof PulledSkillSchema>;

export const SkillPullOutputSchema = z.object({
  skills: z.array(PulledSkillSchema),
});
export type SkillPullOutput = z.infer<typeof SkillPullOutputSchema>;

/** Publishes a skill. Unchanged files return the latest version instead of a new one. */
export const SkillPublishInputSchema = z.object({
  name: SkillNameSchema,
  kind: SkillKindSchema,
  files: SkillFilesSchema,
  changelog: z.string().trim().max(SKILL_CHANGELOG_MAX_LENGTH).optional(),
});
export type SkillPublishInput = z.infer<typeof SkillPublishInputSchema>;

/** `created` is false when the checksum matched the latest version. */
export const SkillPublishOutputSchema = z.object({
  name: SkillNameSchema,
  version: SkillVersionNumberSchema,
  checksum: SkillChecksumSchema,
  created: z.boolean(),
});
export type SkillPublishOutput = z.infer<typeof SkillPublishOutputSchema>;

/**
 * The production tools served on `/mcp`. Producer sessions call them with their job token, bound
 * to the job's project; only publishing skills needs a user's token.
 */
export const pipelineTools = {
  "format.get_rules": {
    name: "format.get_rules",
    scope: "mcp:read",
    jobTokens: "allow",
    projectBinding: "input",
    description:
      "Get the current format rules of a series: tone, reading level, hook style, length, voice, visual style, topics, cadence and caption rules.",
    input: FormatGetRulesInputSchema,
    output: FormatGetRulesOutputSchema,
  },
  "content.create_idea": {
    name: "content.create_idea",
    scope: "mcp:write",
    jobTokens: "allow",
    projectBinding: "input",
    description:
      "Add a video idea (title and pitch) to a project, optionally in a series. It starts in the idea state.",
    input: ContentCreateIdeaInputSchema,
    output: ContentCreateIdeaOutputSchema,
  },
  "content.get": {
    name: "content.get",
    scope: "mcp:read",
    jobTokens: "allow",
    projectBinding: "input",
    description:
      "Get a content item with one version (the current one by default), its script and storyboard, and its format rules.",
    input: ContentGetInputSchema,
    output: ContentGetOutputSchema,
  },
  "content.submit_for_review": {
    name: "content.submit_for_review",
    scope: "mcp:write",
    jobTokens: "allow",
    projectBinding: "input",
    description:
      "Save a new version of an item with a script, a storyboard, a voice take, a finished render (with its poster) or a mix. Media are ready assets of the item from content.upload_asset. The item moves to the stage its artifacts reach, and a version with a render goes to review. Only the owner can approve it, in the web app or with content.review.",
    input: ContentSubmitForReviewInputSchema,
    output: ContentSubmitForReviewOutputSchema,
  },
  "content.upload_asset": {
    name: "content.upload_asset",
    scope: "mcp:write",
    jobTokens: "allow",
    projectBinding: "input",
    description:
      "Start uploading a file for an item (voice, render, poster, frame). PUT the bytes to the returned URL with exactly the returned headers, then call content.finalize_asset. No upload is returned when the item already holds an identical file of that kind.",
    input: ContentUploadAssetInputSchema,
    output: ContentUploadAssetOutputSchema,
  },
  "content.finalize_asset": {
    name: "content.finalize_asset",
    scope: "mcp:write",
    jobTokens: "allow",
    projectBinding: "input",
    description:
      "Finish an upload: the server checks the size and SHA-256 and stores the media probe (and a voice take's word timings).",
    input: ContentFinalizeAssetInputSchema,
    output: ContentFinalizeAssetOutputSchema,
  },
  "asset.get_url": {
    name: "asset.get_url",
    scope: "mcp:read",
    jobTokens: "allow",
    projectBinding: "input",
    description: "Get a short-lived download URL for a ready asset, with its details.",
    input: AssetGetUrlInputSchema,
    output: AssetGetUrlOutputSchema,
  },
  "skill.pull": {
    name: "skill.pull",
    scope: "mcp:read",
    jobTokens: "allow",
    projectBinding: "none",
    description:
      "Download published skills with their files: every skill at its latest version, or one skill.",
    input: SkillPullInputSchema,
    output: SkillPullOutputSchema,
  },
  "skill.publish": {
    name: "skill.publish",
    scope: "mcp:write",
    jobTokens: "deny",
    projectBinding: "none",
    description:
      "Publish a skill or recipe as a new version. Publishing identical files returns the latest version.",
    input: SkillPublishInputSchema,
    output: SkillPublishOutputSchema,
  },
} as const satisfies Record<string, McpToolContract>;

export type PipelineToolName = keyof typeof pipelineTools;
