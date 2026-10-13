import { CAPTION_MAX_LENGTH, type Platform } from "@loomcast/contracts";

// Captions per platform. A post's caption is composed from the version's caption (or the script's),
// the format's call to action and the hashtags, then fitted to the platform's limits: extra
// hashtags are dropped first (from the end), then the call to action, then the text is cut at a
// word boundary with an ellipsis. The request builders fit again, so a request never exceeds a
// limit whatever the caller passed.

export interface CaptionLimits {
  /** Longest caption, counted with `captionLength`. */
  maxLength: number;
  /** Most hashtags, counting those in the text; null for no limit. */
  maxHashtags: number | null;
  /** Most @mentions; null for no limit. More is a validation issue (nothing is removed). */
  maxMentions: number | null;
  /**
   * `chars`: code points. `emoji_bytes`: code points, but characters outside the Basic
   * Multilingual Plane (most emoji) count their UTF-8 length, as Threads counts them.
   * `weighted`: X's weighted length (links count 23, wide characters 2).
   */
  counting: "chars" | "emoji_bytes" | "weighted";
}

/**
 * Caption limits per platform, as the platforms document them for API publishing (confirmed again
 * by the live adapters before they ship):
 * - Instagram Reels: 2,200 characters, 30 hashtags, 20 mentions.
 * - Facebook Page Reels: the description shares the post limit, far above `CAPTION_MAX_LENGTH`,
 *   which therefore applies.
 * - Threads: 500 characters of text; emoji count their UTF-8 length.
 * - X: 280 weighted characters.
 */
export const PLATFORM_CAPTION_LIMITS: { readonly [P in Platform]: CaptionLimits } = {
  instagram: { maxLength: 2_200, maxHashtags: 30, maxMentions: 20, counting: "chars" },
  facebook: {
    maxLength: CAPTION_MAX_LENGTH,
    maxHashtags: null,
    maxMentions: null,
    counting: "chars",
  },
  threads: { maxLength: 500, maxHashtags: null, maxMentions: null, counting: "emoji_bytes" },
  x: { maxLength: 280, maxHashtags: null, maxMentions: null, counting: "weighted" },
};

/** Every link counts as this many characters on X, whatever its length. */
export const X_LINK_LENGTH = 23;

const ELLIPSIS = "…";
const LINK_RE = /https?:\/\/\S+/giu;
const HASHTAG_RE = /(^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]+)/gu;
const MENTION_RE = /(^|[^\p{L}\p{N}_])@([A-Za-z0-9_.]+)/gu;

/** Code points X counts once; everything else (CJK, emoji, most symbols) counts twice. */
const X_LIGHT_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

function xCodePointWeight(codePoint: number): number {
  return X_LIGHT_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to) ? 1 : 2;
}

/** X's weighted length: links count `X_LINK_LENGTH`, wide characters 2, the rest 1. */
export function xWeightedLength(text: string): number {
  const normalized = text.normalize("NFC");
  let length = 0;
  let last = 0;
  for (const match of normalized.matchAll(LINK_RE)) {
    length += weightOf(normalized.slice(last, match.index)) + X_LINK_LENGTH;
    last = match.index + match[0].length;
  }
  return length + weightOf(normalized.slice(last));
}

function weightOf(text: string): number {
  let weight = 0;
  for (const char of text) {
    weight += xCodePointWeight(char.codePointAt(0) ?? 0);
  }
  return weight;
}

/** The length of `text` as `platform` counts it. */
export function captionLength(platform: Platform, text: string): number {
  switch (PLATFORM_CAPTION_LIMITS[platform].counting) {
    case "weighted":
      return xWeightedLength(text);
    case "emoji_bytes": {
      let length = 0;
      for (const char of text) {
        length += (char.codePointAt(0) ?? 0) > 0xffff ? 4 : 1;
      }
      return length;
    }
    default:
      return [...text].length;
  }
}

export function countHashtags(text: string): number {
  return [...text.matchAll(HASHTAG_RE)].length;
}

export function countMentions(text: string): number {
  return [...text.matchAll(MENTION_RE)].length;
}

function fits(platform: Platform, text: string): boolean {
  return captionLength(platform, text) <= PLATFORM_CAPTION_LIMITS[platform].maxLength;
}

/**
 * Cuts `text` so it fits `platform`: at the last word boundary that fits, with an ellipsis. Text
 * that fits is returned as it is, so fitting twice changes nothing.
 */
export function limitCaption(platform: Platform, text: string): string {
  if (fits(platform, text)) {
    return text;
  }
  const chars = [...text];
  let low = 0;
  let high = chars.length;
  // The longest prefix that fits with the ellipsis.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(platform, `${chars.slice(0, mid).join("").trimEnd()}${ELLIPSIS}`)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  let cut = chars.slice(0, low).join("");
  const boundary = cut.search(/\s\S*$/u);
  if (boundary > cut.length / 2) {
    cut = cut.slice(0, boundary);
  }
  return `${cut.trimEnd()}${ELLIPSIS}`;
}

/** The parts a caption is composed from. */
export interface CaptionParts {
  /** The version's caption, or the script's. */
  text: string;
  /** The format's call to action, added to every caption. */
  cta?: string | null;
  /** Without `#`; repeats (ignoring case) are dropped. */
  hashtags?: readonly string[];
}

export type CaptionIssueCode = "too_many_mentions";

export interface CaptionIssue {
  code: CaptionIssueCode;
  message: string;
}

export interface FittedCaption {
  platform: Platform;
  text: string;
  /** True when the text or call to action was cut or left out. */
  truncated: boolean;
  /** Hashtags left out to meet the hashtag or length limit, without `#`. */
  droppedHashtags: string[];
  /** Limits the caption breaks that cutting cannot fix. */
  issues: CaptionIssue[];
}

function join(...blocks: (string | null | undefined)[]): string {
  return blocks
    .map((block) => block?.trim() ?? "")
    .filter((block) => block !== "")
    .join("\n\n");
}

function distinctTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#/, "");
    const key = tag.toLowerCase();
    if (tag !== "" && !seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }
  return result;
}

/**
 * Composes the caption of `platform` from its parts: the text, the call to action and the
 * hashtags, each block separated by a blank line, then fitted to the platform's limits.
 */
export function buildCaption(platform: Platform, parts: CaptionParts): FittedCaption {
  const limits = PLATFORM_CAPTION_LIMITS[platform];
  const body = parts.text.trim();
  const cta = parts.cta?.trim() ?? "";
  let tags = distinctTags(parts.hashtags ?? []).filter(
    (tag) =>
      !new RegExp(`(^|[^\\p{L}\\p{N}_])#${escapeRegExp(tag)}(?![\\p{L}\\p{N}_])`, "iu").test(
        join(body, cta),
      ),
  );
  const dropped: string[] = [];
  if (limits.maxHashtags !== null) {
    const room = Math.max(0, limits.maxHashtags - countHashtags(join(body, cta)));
    dropped.push(...tags.slice(room));
    tags = tags.slice(0, room);
  }
  const compose = (withCta: boolean, list: readonly string[]) =>
    join(body, withCta ? cta : "", list.map((tag) => `#${tag}`).join(" "));

  let text = compose(true, tags);
  while (!fits(platform, text) && tags.length > 0) {
    const last = tags.pop();
    if (last !== undefined) {
      dropped.unshift(last);
    }
    text = compose(true, tags);
  }
  let truncated = false;
  if (!fits(platform, text) && cta !== "") {
    text = compose(false, tags);
    truncated = true;
  }
  if (!fits(platform, text)) {
    text = limitCaption(platform, text);
    truncated = true;
  }

  const issues: CaptionIssue[] = [];
  if (limits.maxMentions !== null && countMentions(text) > limits.maxMentions) {
    issues.push({
      code: "too_many_mentions",
      message: `The caption mentions more than ${limits.maxMentions} accounts.`,
    });
  }
  return { platform, text, truncated, droppedHashtags: dropped, issues };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
