import { z } from "zod";
import { IdSchema } from "../common";
import type { Platform, PostFormat } from "../enums";

// Post formats per platform, the media each format carries, and the options a post may set per
// platform. The API refuses to schedule a format the channel's platform does not publish, the
// publisher picks the request builder by format, and the web app and MCP tools read the same
// tables. The detailed file limits (sizes, durations, aspect ratios) live with each platform's
// request builders.

/** Which formats each platform publishes, in the order the web app offers them. */
export const PLATFORM_FORMATS = {
  instagram: ["reel", "image", "carousel", "story"],
  facebook: ["reel", "video", "image", "carousel", "story", "text"],
  threads: ["reel"],
  x: ["reel"],
} as const satisfies { readonly [P in Platform]: readonly PostFormat[] };

/** Platform names as messages show them. */
export const PLATFORM_LABELS = {
  facebook: "Facebook",
  instagram: "Instagram",
  threads: "Threads",
  x: "X",
} as const satisfies { readonly [P in Platform]: string };

/** Whether channels of `platform` can publish `format`. */
export function platformSupportsFormat(platform: Platform, format: PostFormat): boolean {
  return (PLATFORM_FORMATS[platform] as readonly PostFormat[]).includes(format);
}

/** Whether a post item is a photo or a video. */
export const MEDIA_TYPES = ["image", "video"] as const;
export const MediaTypeSchema = z.enum(MEDIA_TYPES);
export type MediaType = (typeof MEDIA_TYPES)[number];

/** The MIME types of each media type a post may carry. */
export const MEDIA_TYPE_MIMES = {
  image: ["image/jpeg", "image/png", "image/webp"],
  video: ["video/mp4", "video/quicktime"],
} as const satisfies { readonly [T in MediaType]: readonly string[] };

/** The media type of a MIME type, or null when a post cannot carry it. */
export function mediaTypeOfMime(mime: string): MediaType | null {
  for (const type of MEDIA_TYPES) {
    if ((MEDIA_TYPE_MIMES[type] as readonly string[]).includes(mime)) {
      return type;
    }
  }
  return null;
}

export const ALT_TEXT_MAX_LENGTH = 1_000;
export const MAX_POST_MEDIA = 10;

/** One photo or video of a post, in order. The asset is a ready `media` asset of the item. */
export const PostMediaEntrySchema = z.object({
  assetId: IdSchema,
  type: MediaTypeSchema,
  /** What the photo shows, for screen readers (Instagram and Facebook photos). */
  altText: z.string().trim().max(ALT_TEXT_MAX_LENGTH).optional(),
});
export type PostMediaEntry = z.infer<typeof PostMediaEntrySchema>;

export const PostMediaSchema = z.array(PostMediaEntrySchema).max(MAX_POST_MEDIA);

/**
 * What each format carries:
 * - `render`: the video comes from the version's render (a studio video) or, without one, from
 *   a single video in `media`.
 * - `min` / `max`: how many `media` entries, of the listed `types`.
 */
export interface FormatMediaRule {
  readonly render: boolean;
  readonly min: number;
  readonly max: number;
  readonly types: readonly MediaType[];
}

export const FORMAT_MEDIA_RULES = {
  reel: { render: true, min: 0, max: 1, types: ["video"] },
  video: { render: true, min: 0, max: 1, types: ["video"] },
  image: { render: false, min: 1, max: 1, types: ["image"] },
  carousel: { render: false, min: 2, max: MAX_POST_MEDIA, types: ["image", "video"] },
  story: { render: false, min: 1, max: 1, types: ["image", "video"] },
  text: { render: false, min: 0, max: 0, types: [] },
} as const satisfies { readonly [F in PostFormat]: FormatMediaRule };

/** Platforms whose carousels take photos only (a Facebook multi-photo post). */
export const PHOTO_ONLY_CAROUSEL_PLATFORMS = ["facebook"] as const satisfies readonly Platform[];

/** What a version holds that decides whether it can be published. */
export interface PublishableArtifacts {
  readonly format?: PostFormat | null;
  readonly renderAssetId?: string | null;
  readonly media?: readonly Pick<PostMediaEntry, "type">[] | null;
}

/** Why a version's media do not fit its format; empty when they do. */
export function formatMediaIssues(version: PublishableArtifacts): string[] {
  const format = version.format ?? "reel";
  const rule: FormatMediaRule = FORMAT_MEDIA_RULES[format];
  const media = version.media ?? [];
  const issues: string[] = [];
  if (media.length > rule.max || (rule.max === 0 && media.length > 0)) {
    issues.push(
      rule.max === 0
        ? `A ${format} post carries no photos or videos.`
        : `A ${format} post carries at most ${rule.max} ${rule.max === 1 ? "item" : "items"}.`,
    );
  }
  for (const entry of media) {
    if (!rule.types.includes(entry.type)) {
      issues.push(`A ${format} post cannot carry a ${entry.type}.`);
      break;
    }
  }
  const hasRender = version.renderAssetId !== undefined && version.renderAssetId !== null;
  if (rule.render) {
    if (!hasRender && media.length === 0) {
      issues.push(`A ${format} post needs a video.`);
    }
  } else if (media.length < rule.min) {
    issues.push(
      `A ${format} post needs at least ${rule.min} ${rule.min === 1 ? "item" : "items"}.`,
    );
  }
  return issues;
}

/** Whether a version has everything its format needs to be reviewed, approved and published. */
export function isPublishable(version: PublishableArtifacts): boolean {
  return formatMediaIssues(version).length === 0;
}

/** Whether a version is a studio video, made by the production pipeline (script to render). */
export function isProducedFormat(format: PostFormat | null | undefined): boolean {
  return format === undefined || format === null || format === "reel";
}

// Per-post options. Every field is optional; a platform ignores the options of the others.

export const INSTAGRAM_MAX_COLLABORATORS = 3;
export const POST_TITLE_MAX_LENGTH = 255;

export const InstagramPostOptionsSchema = z
  .object({
    /** Reels: also show the Reel in the profile grid. Defaults to true. */
    shareToFeed: z.boolean().optional(),
    /** Usernames invited as collaborators (feed posts, carousels and Reels). */
    collaborators: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9._]{1,30}$/),
      )
      .max(INSTAGRAM_MAX_COLLABORATORS)
      .optional(),
    /** A Facebook Page id used as the post's location. */
    locationId: z
      .string()
      .trim()
      .regex(/^\d{1,30}$/)
      .optional(),
    /** Reels without a poster: the frame used as the cover, in milliseconds from the start. */
    thumbOffsetMs: z.number().int().min(0).optional(),
  })
  .strict();
export type InstagramPostOptions = z.infer<typeof InstagramPostOptionsSchema>;

export const FacebookPostOptionsSchema = z
  .object({
    /** Text posts: a link shown as a preview card. */
    link: z
      .url({ protocol: /^https?$/ })
      .max(2_048)
      .optional(),
    /** Videos: the title shown above the video. */
    title: z.string().trim().min(1).max(POST_TITLE_MAX_LENGTH).optional(),
  })
  .strict();
export type FacebookPostOptions = z.infer<typeof FacebookPostOptionsSchema>;

/** Options of one scheduled post, per platform. */
export const PostOptionsSchema = z
  .object({
    instagram: InstagramPostOptionsSchema.optional(),
    facebook: FacebookPostOptionsSchema.optional(),
  })
  .strict();
export type PostOptions = z.infer<typeof PostOptionsSchema>;

/** The format names as the web app and the MCP tools show them. */
export const POST_FORMAT_LABELS = {
  reel: "Reel",
  video: "Video",
  image: "Photo",
  carousel: "Carousel",
  story: "Story",
  text: "Text post",
} as const satisfies { readonly [F in PostFormat]: string };
