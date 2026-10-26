import { z } from "zod";
import { MAX_CALENDAR_FILTER_IDS, ScheduledPostSchema } from "../api/calendar";
import {
  ContentItemSchema,
  ContentPitchSchema,
  ContentTitleSchema,
  ContentVersionSchema,
  VersionNotesSchema,
} from "../api/content";
import { IdSchema, TimestampSchema } from "../common";
import {
  PipelineStateSchema,
  PLATFORMS,
  type Platform,
  PlatformSchema,
  POST_FORMATS,
  type PostFormat,
  PostFormatSchema,
} from "../enums";
import { CAPTION_MAX_LENGTH } from "../pipeline/artifacts";
import {
  ALT_TEXT_MAX_LENGTH,
  FORMAT_MEDIA_RULES,
  INSTAGRAM_MAX_COLLABORATORS,
  MAX_POST_MEDIA,
  MEDIA_TYPE_MIMES,
  MEDIA_TYPES,
  MediaTypeSchema,
  PHOTO_ONLY_CAROUSEL_PLATFORMS,
  PLATFORM_FORMATS,
  PLATFORM_LABELS,
  POST_FORMAT_LABELS,
  POST_TITLE_MAX_LENGTH,
  type PostOptions,
  PostOptionsSchema,
} from "../publishing/formats";
import type { McpToolContract } from "./contract";

// Composed posts over MCP: photos, carousels, stories, text posts, Facebook videos and Reels made
// from an uploaded video, put together from the item's `media` assets instead of produced by the
// studio pipeline. The owner creates the post, uploads its files with `content.upload_asset`,
// composes it and schedules it on several channels in one call.

type OptionField<P extends keyof PostOptions> = keyof NonNullable<PostOptions[P]> & string;

/** One per-post option of a platform, as `post.formats` lists it. */
export interface PostOptionField {
  readonly platform: keyof PostOptions;
  readonly field: string;
  readonly type: "boolean" | "integer" | "string" | "string[]" | "url";
  /** The formats the option applies to; the platform ignores it on the others. */
  readonly formats: readonly PostFormat[];
  readonly description: string;
}

/** The fields of `PostOptionsSchema`, described for MCP clients and the web app. */
export const POST_OPTION_FIELDS = [
  {
    platform: "instagram",
    field: "shareToFeed" satisfies OptionField<"instagram">,
    type: "boolean",
    formats: ["reel"],
    description: "Also show the Reel in the profile grid. Defaults to true.",
  },
  {
    platform: "instagram",
    field: "collaborators" satisfies OptionField<"instagram">,
    type: "string[]",
    formats: ["reel", "image", "carousel"],
    description: `Up to ${INSTAGRAM_MAX_COLLABORATORS} usernames invited as collaborators.`,
  },
  {
    platform: "instagram",
    field: "locationId" satisfies OptionField<"instagram">,
    type: "string",
    formats: ["reel", "image", "carousel"],
    description: "A Facebook Page id (digits only) used as the post's location.",
  },
  {
    platform: "instagram",
    field: "thumbOffsetMs" satisfies OptionField<"instagram">,
    type: "integer",
    formats: ["reel"],
    description: "Reels without a poster: the frame used as the cover, in ms from the start.",
  },
  {
    platform: "facebook",
    field: "link" satisfies OptionField<"facebook">,
    type: "url",
    formats: ["text"],
    description: "Text posts: an http(s) link shown as a preview card.",
  },
  {
    platform: "facebook",
    field: "title" satisfies OptionField<"facebook">,
    type: "string",
    formats: ["video"],
    description: `Videos: the title shown above the video, at most ${POST_TITLE_MAX_LENGTH} characters.`,
  },
] as const satisfies readonly PostOptionField[];

export const PostFormatsInputSchema = z.object({});
export type PostFormatsInput = z.infer<typeof PostFormatsInputSchema>;

/** What each format carries and which platforms publish it. */
export const PostFormatsOutputSchema = z.object({
  formats: z.array(
    z.object({
      format: PostFormatSchema,
      label: z.string(),
      /** The video may come from a studio render instead of `media`. */
      render: z.boolean(),
      /** How many `media` entries, of which types. */
      min: z.number().int().min(0),
      max: z.number().int().min(0),
      types: z.array(MediaTypeSchema),
      platforms: z.array(PlatformSchema),
    }),
  ),
  platforms: z.array(
    z.object({
      platform: PlatformSchema,
      label: z.string(),
      formats: z.array(PostFormatSchema),
    }),
  ),
  /** The MIME types of `media` assets per media type. */
  mediaTypes: z.array(z.object({ type: MediaTypeSchema, mimes: z.array(z.string()) })),
  /** Platforms whose carousels take photos only. */
  photoOnlyCarouselPlatforms: z.array(PlatformSchema),
  /** The `options` fields `post.schedule` takes, per platform. */
  options: z.array(
    z.object({
      platform: PlatformSchema,
      field: z.string(),
      type: z.string(),
      formats: z.array(PostFormatSchema),
      description: z.string(),
    }),
  ),
});
export type PostFormatsOutput = z.infer<typeof PostFormatsOutputSchema>;

/** The tables of `publishing/formats` as one document. */
export function postFormatCatalog(): PostFormatsOutput {
  const platformsOf = (format: PostFormat): Platform[] =>
    PLATFORMS.filter((platform) =>
      (PLATFORM_FORMATS[platform] as readonly PostFormat[]).includes(format),
    );
  return {
    formats: POST_FORMATS.map((format) => {
      const rule = FORMAT_MEDIA_RULES[format];
      return {
        format,
        label: POST_FORMAT_LABELS[format],
        render: rule.render,
        min: rule.min,
        max: rule.max,
        types: [...rule.types],
        platforms: platformsOf(format),
      };
    }),
    platforms: PLATFORMS.map((platform) => ({
      platform,
      label: PLATFORM_LABELS[platform],
      formats: [...PLATFORM_FORMATS[platform]],
    })),
    mediaTypes: MEDIA_TYPES.map((type) => ({ type, mimes: [...MEDIA_TYPE_MIMES[type]] })),
    photoOnlyCarouselPlatforms: [...PHOTO_ONLY_CAROUSEL_PLATFORMS],
    options: POST_OPTION_FIELDS.map((option) => ({ ...option, formats: [...option.formats] })),
  };
}

const CaptionSchema = z.string().trim().max(CAPTION_MAX_LENGTH);

/** A new composed post in a workspace. The caption may come now or with `post.compose`. */
export const PostCreateInputSchema = z.object({
  workspaceId: IdSchema,
  title: ContentTitleSchema,
  format: PostFormatSchema,
  caption: CaptionSchema.optional(),
  pitch: ContentPitchSchema.optional(),
  /** When the post should go out, for planning; `post.schedule` sets the real time. */
  targetAt: TimestampSchema.optional(),
});
export type PostCreateInput = z.infer<typeof PostCreateInputSchema>;

/**
 * A composed post after a write: the item, its current version, what its format still misses
 * (empty once it can be scheduled) and the next call to make.
 */
export const PostComposedOutputSchema = z.object({
  item: ContentItemSchema,
  version: ContentVersionSchema,
  issues: z.array(z.string()),
  next: z.string(),
});
export type PostComposedOutput = z.infer<typeof PostComposedOutputSchema>;

/** One photo or video of a post, in order. Its type is read from the asset's MIME type. */
export const PostComposeMediaSchema = z.object({
  assetId: IdSchema,
  /** What the photo shows, for screen readers. */
  altText: z.string().trim().max(ALT_TEXT_MAX_LENGTH).optional(),
});
export type PostComposeMedia = z.infer<typeof PostComposeMediaSchema>;

/**
 * A new version of a composed post. Fields left out are kept; `media` replaces the whole list,
 * and an empty list removes every file. With `baseVersionId`, a stale base is a conflict.
 */
export const PostComposeInputSchema = z
  .object({
    itemId: IdSchema,
    baseVersionId: IdSchema.optional(),
    format: PostFormatSchema.optional(),
    media: z.array(PostComposeMediaSchema).max(MAX_POST_MEDIA).optional(),
    caption: CaptionSchema.nullable().optional(),
    notes: VersionNotesSchema.optional(),
  })
  .refine(
    (input) =>
      input.format !== undefined ||
      input.media !== undefined ||
      input.caption !== undefined ||
      input.notes !== undefined,
    { message: "Change the format, the media, the caption or the notes" },
  )
  .refine(
    (input) =>
      input.media === undefined ||
      new Set(input.media.map((entry) => entry.assetId)).size === input.media.length,
    { message: "The same file appears twice", path: ["media"] },
  );
export type PostComposeInput = z.infer<typeof PostComposeInputSchema>;

/** At most `MAX_CALENDAR_FILTER_IDS` channels, without repeats. */
const ScheduleChannelIdsSchema = z
  .array(IdSchema)
  .min(1)
  .max(MAX_CALENDAR_FILTER_IDS)
  .refine((ids) => new Set(ids).size === ids.length, { message: "Ids must not repeat" });

/**
 * Approves (when needed) and schedules an item on every channel at one time, all or nothing.
 * `versionId`, when given, must be the item's current version.
 */
export const PostScheduleInputSchema = z.object({
  itemId: IdSchema,
  versionId: IdSchema.optional(),
  channelIds: ScheduleChannelIdsSchema,
  scheduledAt: TimestampSchema,
  options: PostOptionsSchema.optional(),
});
export type PostScheduleInput = z.infer<typeof PostScheduleInputSchema>;

/** The posts created, one per channel in the order given, and the item's state after them. */
export const PostScheduleOutputSchema = z.object({
  itemId: IdSchema,
  versionId: IdSchema,
  state: PipelineStateSchema,
  /** The owner's approval recorded on the way; null when the item was already approved. */
  reviewId: IdSchema.nullable(),
  posts: z.array(ScheduledPostSchema),
});
export type PostScheduleOutput = z.infer<typeof PostScheduleOutputSchema>;

/**
 * `post.formats` is reference data any token may read. The others are the owner's: they need
 * `mcp:admin`, act as the owner, and are never open to job tokens.
 */
export const postTools = {
  "post.formats": {
    name: "post.formats",
    scope: "mcp:read",
    jobTokens: "allow",
    workspaceBinding: "none",
    description:
      "List the post formats (reel, video, image, carousel, story, text), the photos and videos each carries, the platforms that publish each, the MIME types per media type and the per-platform options post.schedule takes.",
    input: PostFormatsInputSchema,
    output: PostFormatsOutputSchema,
  },
  "post.create": {
    name: "post.create",
    scope: "mcp:admin",
    jobTokens: "deny",
    workspaceBinding: "input",
    description:
      "Owner only. Create a composed post in a workspace: a photo (image), carousel, story, text post, Facebook video or a Reel from an uploaded video, with no studio production. Next: upload each file with content.upload_asset (kind media, this itemId) and content.finalize_asset, then call post.compose. A text post with a caption is ready for post.schedule at once. For a studio video use content.create_idea.",
    input: PostCreateInputSchema,
    output: PostComposedOutputSchema,
  },
  "post.compose": {
    name: "post.compose",
    scope: "mcp:admin",
    jobTokens: "deny",
    workspaceBinding: "input",
    description:
      "Owner only. Save a new version of a composed post: its format, its files in order (ready media assets of the item; photo or video is read from the file type, altText describes a photo) and its caption. Fields left out are kept; media replaces the whole list. issues lists what the format still misses; when empty the item is in render and post.schedule can schedule it.",
    input: PostComposeInputSchema,
    output: PostComposedOutputSchema,
  },
  "post.schedule": {
    name: "post.schedule",
    scope: "mcp:admin",
    jobTokens: "deny",
    workspaceBinding: "input",
    description:
      "Owner only. Schedule an item on one or more channels at one time, at least two minutes ahead. An item in render is submitted and approved, one in review approved, as the owner's review; an approved or scheduled item is just scheduled. All or nothing: when a channel is unknown, disabled, already has the item or does not publish its format (see post.formats), nothing changes and the error lists every refused channel.",
    input: PostScheduleInputSchema,
    output: PostScheduleOutputSchema,
  },
} as const satisfies Record<string, McpToolContract>;

export type PostToolName = keyof typeof postTools;
