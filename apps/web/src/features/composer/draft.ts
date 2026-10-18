import {
  ALT_TEXT_MAX_LENGTH,
  CAPTION_MAX_LENGTH,
  FacebookPostOptionsSchema,
  FORMAT_MEDIA_RULES,
  formatMediaIssues,
  INSTAGRAM_MAX_COLLABORATORS,
  InstagramPostOptionsSchema,
  type MediaType,
  type Platform,
  type PostFormat,
  type PostMediaEntry,
  type PostOptions,
} from "@loomcast/contracts";
import { POST_MEDIA_ACCEPT, POST_MEDIA_ACCEPT_BY_TYPE } from "@/features/post-formats/media-upload";

// The composer's draft: the photos and videos picked so far, what the format still needs, and the
// per-platform options of the posts it schedules. Kept apart from the components so the rules can
// be tested on their own.

/** One photo or video in the composer, before and after it is uploaded. */
export interface MediaDraft {
  key: string;
  file: File;
  type: MediaType;
  /** An object URL for the preview; revoked when the entry is removed. */
  url: string;
  altText: string;
  /** Set once the file is a ready `media` asset of the item. */
  assetId?: string | undefined;
}

/** Moves the entry at `from` to `to`, keeping the others in order. */
export function moveEntry<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) {
    return [...list];
  }
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

/** Whether the format takes more than one photo or video. */
export function takesSeveral(format: PostFormat): boolean {
  return FORMAT_MEDIA_RULES[format].max > 1;
}

/** Whether the format carries photos or videos at all. */
export function takesMedia(format: PostFormat): boolean {
  return FORMAT_MEDIA_RULES[format].max > 0;
}

/** What the file picker offers for a format. */
export function acceptFor(format: PostFormat): string {
  const types: readonly MediaType[] = FORMAT_MEDIA_RULES[format].types;
  if (types.length === 1) return POST_MEDIA_ACCEPT_BY_TYPE[types[0] as MediaType];
  return POST_MEDIA_ACCEPT;
}

/** The sentence for what a format carries, under the media picker. */
export function mediaHint(format: PostFormat): string {
  switch (format) {
    case "image":
      return "One photo.";
    case "carousel":
      return "2 to 10 photos or videos. Facebook carousels take photos only.";
    case "story":
      return "One photo or video, shown for 24 hours.";
    case "reel":
      return "One vertical video.";
    case "video":
      return "One video.";
    default:
      return "Words only, with an optional link.";
  }
}

/**
 * Why the draft can't be saved yet: the contracts' `formatMediaIssues` for its media, a text post
 * without words, and alt text over the limit. Empty when it can.
 */
export function draftIssues(
  format: PostFormat,
  media: readonly Pick<MediaDraft, "type" | "altText">[],
  caption: string,
): string[] {
  const issues = formatMediaIssues({ format, media });
  if (format === "text" && caption.trim() === "") issues.push("A text post needs its words.");
  if (caption.trim().length > CAPTION_MAX_LENGTH) {
    issues.push(`Keep the caption to ${CAPTION_MAX_LENGTH.toLocaleString("en")} characters.`);
  }
  if (media.some((entry) => entry.altText.trim().length > ALT_TEXT_MAX_LENGTH)) {
    issues.push(`Keep alt text to ${ALT_TEXT_MAX_LENGTH.toLocaleString("en")} characters.`);
  }
  return issues;
}

/** The media entries a version is written with, in order. Every draft must be uploaded. */
export function mediaEntries(media: readonly MediaDraft[]): PostMediaEntry[] {
  return media.map((entry) => {
    if (!entry.assetId) throw new Error("Upload every file first.");
    const alt = entry.altText.trim();
    return {
      assetId: entry.assetId,
      type: entry.type,
      ...(entry.type === "image" && alt ? { altText: alt } : {}),
    };
  });
}

// Per-platform options -------------------------------------------------------------------

/** The option fields as the schedule form holds them: plain strings and a switch. */
export interface OptionFields {
  collaborators: string;
  locationId: string;
  shareToFeed: boolean;
  link: string;
  title: string;
}

export const EMPTY_OPTIONS: OptionFields = {
  collaborators: "",
  locationId: "",
  shareToFeed: true,
  link: "",
  title: "",
};

export type OptionField = keyof OptionFields;

/** Which option fields a post of `format` offers on `platform`. */
export function optionFieldsFor(platform: Platform, format: PostFormat): OptionField[] {
  if (platform === "instagram") {
    if (format === "story") return [];
    const fields: OptionField[] = ["collaborators", "locationId"];
    if (format === "reel") fields.push("shareToFeed");
    return fields;
  }
  if (platform === "facebook") {
    if (format === "text") return ["link"];
    if (format === "video") return ["title"];
  }
  return [];
}

/** Usernames from a list typed with commas or spaces, without `@`. */
export function parseCollaborators(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((name) => name.replace(/^@/, "").trim())
    .filter(Boolean);
}

export interface BuiltOptions {
  /** The options to send, or undefined when there are none. */
  options: PostOptions | undefined;
  /** Messages by field, for fields that are not valid. */
  errors: Partial<Record<OptionField, string>>;
}

/**
 * The `options` of the posts the form schedules: only the fields the chosen platforms offer for
 * the format, only those filled in, checked with the contracts' schemas.
 */
export function buildOptions(
  fields: OptionFields,
  format: PostFormat,
  platforms: readonly Platform[],
): BuiltOptions {
  const errors: BuiltOptions["errors"] = {};
  const options: PostOptions = {};
  const offered = (platform: Platform) =>
    platforms.includes(platform) ? optionFieldsFor(platform, format) : [];

  const instagram = offered("instagram");
  if (instagram.length > 0) {
    const value: Record<string, unknown> = {};
    const names = parseCollaborators(fields.collaborators);
    if (instagram.includes("collaborators") && names.length > 0) {
      if (names.length > INSTAGRAM_MAX_COLLABORATORS) {
        errors.collaborators = `Invite at most ${INSTAGRAM_MAX_COLLABORATORS} collaborators.`;
      } else if (!InstagramPostOptionsSchema.shape.collaborators.safeParse(names).success) {
        errors.collaborators = "Use Instagram usernames: letters, numbers, dots and underscores.";
      } else {
        value.collaborators = names;
      }
    }
    const location = fields.locationId.trim();
    if (instagram.includes("locationId") && location) {
      if (InstagramPostOptionsSchema.shape.locationId.safeParse(location).success) {
        value.locationId = location;
      } else {
        errors.locationId = "A location is a Facebook Page id: digits only.";
      }
    }
    if (instagram.includes("shareToFeed") && !fields.shareToFeed) value.shareToFeed = false;
    if (Object.keys(value).length > 0) options.instagram = value;
  }

  const facebook = offered("facebook");
  if (facebook.length > 0) {
    const value: Record<string, unknown> = {};
    const link = fields.link.trim();
    if (facebook.includes("link") && link) {
      if (FacebookPostOptionsSchema.shape.link.safeParse(link).success) value.link = link;
      else errors.link = "Use a full web address that starts with https://.";
    }
    const title = fields.title.trim();
    if (facebook.includes("title") && title) {
      if (FacebookPostOptionsSchema.shape.title.safeParse(title).success) value.title = title;
      else errors.title = "Keep the title to 255 characters.";
    }
    if (Object.keys(value).length > 0) options.facebook = value;
  }

  return {
    options: Object.keys(options).length > 0 ? options : undefined,
    errors,
  };
}
