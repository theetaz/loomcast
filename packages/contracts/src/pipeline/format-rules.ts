import { z } from "zod";
import { PublishModeSchema } from "../enums";
import { SkillNameSchema, SkillVersionNumberSchema } from "./skills";
import { CARD_ID_RE, StyleIdSchema } from "./style";

// The rules of a format: how every video of a series sounds, looks, how long it runs and when it
// is published. Formats are versioned; each content version records the format version it was
// produced with, and production jobs carry a snapshot of the rules.

export const FORMAT_TONE_MAX_LENGTH = 200;
export const FORMAT_NOTES_MAX_LENGTH = 1_000;
export const FORMAT_TOPIC_MAX_LENGTH = 200;
export const FORMAT_MAX_TOPICS = 500;
export const FORMAT_MAX_AVOID = 200;
export const FORMAT_MAX_SLOTS = 12;
export const FORMAT_CTA_MAX_LENGTH = 300;
export const MAX_HASHTAGS = 30;
export const HASHTAG_MAX_LENGTH = 100;
export const VOICE_ID_MAX_LENGTH = 100;

export const READING_GRADE_MIN = 3;
export const READING_GRADE_MAX = 16;
export const LENGTH_SEC_MIN = 5;
export const LENGTH_SEC_MAX = 180;
export const VOICE_SPEED_MIN = 0.7;
export const VOICE_SPEED_MAX = 1.3;
export const LEAD_TIME_HOURS_MIN = 1;
export const LEAD_TIME_HOURS_MAX = 336;

/** How a script opens. */
export const HOOK_STYLES = [
  "question",
  "bold_claim",
  "statistic",
  "story",
  "contrarian",
  "demo",
] as const;
export const HookStyleSchema = z.enum(HOOK_STYLES);
export type HookStyle = (typeof HOOK_STYLES)[number];

/** `word` highlights one spoken word at a time; `line` shows whole caption lines. */
export const CAPTION_STYLES = ["word", "line"] as const;
export const CaptionStyleSchema = z.enum(CAPTION_STYLES);
export type CaptionStyle = (typeof CAPTION_STYLES)[number];

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const WeekdaySchema = z.enum(WEEKDAYS);
export type Weekday = (typeof WEEKDAYS)[number];

/** A 24-hour local time, `HH:mm`. */
export const TIME_OF_DAY_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const TimeOfDaySchema = z.string().regex(TIME_OF_DAY_RE, {
  message: "Use a 24-hour time such as 09:30",
});

/** IANA zone names such as `UTC`, `Europe/London` or `America/Argentina/Buenos_Aires`. */
const TIME_ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/**
 * Whether `value` is an IANA time zone this runtime knows. Offsets such as `+05:30` are refused:
 * they ignore daylight saving time.
 */
export function isTimeZone(value: string): boolean {
  if (value.length > 64 || !TIME_ZONE_RE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const TimeZoneSchema = z.string().refine(isTimeZone, {
  message: "Use an IANA time zone such as Europe/London",
});

/**
 * A hashtag without its `#`: letters, digits and underscores, at most 100. A leading `#` is
 * removed, so `#RustLang` is stored as `RustLang`.
 */
export const HashtagSchema = z
  .string()
  .trim()
  .transform((tag) => tag.replace(/^#/, ""))
  .pipe(
    z.string().regex(/^[\p{L}\p{N}_]{1,100}$/u, {
      message: "Use letters, digits and underscores only",
    }),
  );

/** At most 30 hashtags, without repeats (compared without case). */
export const HashtagsSchema = z
  .array(HashtagSchema)
  .max(MAX_HASHTAGS)
  .refine(isDistinctIgnoringCase, { message: "Hashtags must not repeat" });

function isDistinctIgnoringCase(values: readonly string[]): boolean {
  return new Set(values.map((value) => value.toLowerCase())).size === values.length;
}

function isDistinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** The TTS provider's voice id. */
export const VoiceIdSchema = z.string().trim().min(1).max(VOICE_ID_MAX_LENGTH);

const TopicSchema = z.string().trim().min(1).max(FORMAT_TOPIC_MAX_LENGTH);

export const LengthSecSchema = z
  .object({
    min: z.number().int().min(LENGTH_SEC_MIN).max(LENGTH_SEC_MAX),
    max: z.number().int().min(LENGTH_SEC_MIN).max(LENGTH_SEC_MAX),
  })
  .refine((length) => length.min <= length.max, {
    message: "The shortest length must not exceed the longest",
    path: ["max"],
  });
export type LengthSec = z.infer<typeof LengthSecSchema>;

export const VisualTemplateSchema = z.object({
  styleId: StyleIdSchema,
  /** A layout template within the style. Without it the studio runtime picks its default. */
  templateId: z.string().regex(CARD_ID_RE).optional(),
  captions: z.object({
    enabled: z.boolean(),
    style: CaptionStyleSchema,
  }),
});
export type VisualTemplate = z.infer<typeof VisualTemplateSchema>;

/**
 * When a series publishes: on the listed days, at each slot (local time in `tz`). Items are due
 * for production `leadTimeHours` before their slot. No days or no slots means no calendar slots.
 */
export const CadenceSchema = z.object({
  days: z.array(WeekdaySchema).max(WEEKDAYS.length).refine(isDistinct, {
    message: "Days must not repeat",
  }),
  slots: z.array(TimeOfDaySchema).max(FORMAT_MAX_SLOTS).refine(isDistinct, {
    message: "Times must not repeat",
  }),
  tz: TimeZoneSchema,
  leadTimeHours: z.number().int().min(LEAD_TIME_HOURS_MIN).max(LEAD_TIME_HOURS_MAX),
});
export type Cadence = z.infer<typeof CadenceSchema>;

export const FormatCaptionSchema = z.object({
  hashtags: HashtagsSchema,
  /** A call to action added to every caption. */
  cta: z.string().trim().max(FORMAT_CTA_MAX_LENGTH).optional(),
});
export type FormatCaption = z.infer<typeof FormatCaptionSchema>;

/** A recipe skill that guides production. Without `version` the latest version is used. */
export const FormatRecipeSchema = z.object({
  name: SkillNameSchema,
  version: SkillVersionNumberSchema.optional(),
});
export type FormatRecipe = z.infer<typeof FormatRecipeSchema>;

/** The rules of one format version. */
export const FormatRulesSchema = z.object({
  tone: z.string().trim().max(FORMAT_TONE_MAX_LENGTH),
  readingLevel: z.object({
    grade: z.number().int().min(READING_GRADE_MIN).max(READING_GRADE_MAX),
  }),
  hookStyle: HookStyleSchema,
  hookNotes: z.string().trim().max(FORMAT_NOTES_MAX_LENGTH).optional(),
  lengthSec: LengthSecSchema,
  /** Without a voice the `voice` step cannot run (`voice_not_configured`). */
  voiceId: VoiceIdSchema.optional(),
  /** Speaking rate; 1 is the voice's normal speed. */
  voiceSpeed: z.number().min(VOICE_SPEED_MIN).max(VOICE_SPEED_MAX).optional(),
  visualTemplate: VisualTemplateSchema,
  /** Topics to draw new ideas from. */
  topicPool: z.array(TopicSchema).max(FORMAT_MAX_TOPICS),
  /** Topics, words or claims the producer must stay away from. */
  avoid: z.array(TopicSchema).max(FORMAT_MAX_AVOID),
  cadence: CadenceSchema,
  publishMode: PublishModeSchema,
  caption: FormatCaptionSchema,
  recipe: FormatRecipeSchema.optional(),
});
export type FormatRules = z.infer<typeof FormatRulesSchema>;
export type FormatRulesInput = z.input<typeof FormatRulesSchema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Rules for a new format. Frozen: copy it (`structuredClone`) before changing anything. It has no
 * voice, so the `voice` step waits until one is chosen.
 */
export const DEFAULT_FORMAT_RULES: FormatRules = deepFreeze({
  tone: "Clear, direct and friendly. Short sentences, no filler.",
  readingLevel: { grade: 8 },
  hookStyle: "bold_claim",
  lengthSec: { min: 30, max: 60 },
  visualTemplate: {
    styleId: "vox-explainer",
    captions: { enabled: true, style: "word" },
  },
  topicPool: [],
  avoid: [],
  cadence: {
    days: ["mon", "wed", "fri"],
    slots: ["09:00"],
    tz: "UTC",
    leadTimeHours: 24,
  },
  publishMode: "approval",
  caption: { hashtags: [] },
});
