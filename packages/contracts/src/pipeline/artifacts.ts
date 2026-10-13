import { z } from "zod";
import { isPlainText } from "../api/kb";
import { HashtagsSchema } from "./format-rules";
import { CardIdSchema, SlotNameSchema, StyleIdSchema } from "./style";

// The artifacts of a content version: the script, the storyboard that sets it to cards, and the
// word timings of the voice. Producer sessions write the first two as JSON; the voice step
// reports the third. Every one of them fits in a single bridge frame.

/** Longest timeline any artifact may describe: ten minutes, well past the longest format. */
export const MAX_TIMELINE_MS = 10 * 60_000;

export const SCRIPT_TITLE_MAX_LENGTH = 200;
export const SCRIPT_HOOK_MAX_LENGTH = 500;
export const SCRIPT_MAX_SEGMENTS = 60;
export const SEGMENT_TEXT_MAX_LENGTH = 1_000;
export const ON_SCREEN_TEXT_MAX_LENGTH = 280;
export const SCRIPT_CTA_MAX_LENGTH = 300;
/** Instagram's caption limit, the tightest of the target platforms. */
export const CAPTION_MAX_LENGTH = 2_200;

export const STORYBOARD_FPS = 30;
export const STORYBOARD_ASPECT = "9:16";
export const STORYBOARD_MAX_FRAMES = 80;
export const FRAME_MAX_SLOTS = 32;
export const SLOT_TEXT_MAX_LENGTH = 280;
/** Total slot text of a storyboard, which keeps a storyboard result well under 1 MiB. */
export const STORYBOARD_MAX_SLOT_TEXT = 100_000;
export const FRAME_NOTES_MAX_LENGTH = 1_000;

export const ALIGNMENT_MAX_WORDS = 5_000;
export const ALIGNED_WORD_MAX_LENGTH = 100;

/** A segment or frame id, unique within its script or storyboard: `s1`, `hook`, `frame-03`. */
export const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const ArtifactIdSchema = z.string().regex(ARTIFACT_ID_RE, {
  message: "Use 1 to 32 letters, digits, hyphens and underscores",
});

const TimeMsSchema = z.number().int().min(0).max(MAX_TIMELINE_MS);

/** Text without control characters (other than tab and line breaks) or lone surrogates. */
function plainText(max: number, options: { min?: number } = {}) {
  return z
    .string()
    .max(max)
    .refine((text) => text.trim().length >= (options.min ?? 0), {
      message: "The text must not be empty",
    })
    .refine(isPlainText, { message: "The text contains control characters" });
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * One spoken segment. `startMs` and `endMs` are filled from the voice timings once a voice
 * exists; `onScreenText` is the text a card shows while it plays.
 */
export const ScriptSegmentSchema = z
  .object({
    id: ArtifactIdSchema,
    text: plainText(SEGMENT_TEXT_MAX_LENGTH, { min: 1 }),
    startMs: TimeMsSchema.optional(),
    endMs: TimeMsSchema.optional(),
    onScreenText: plainText(ON_SCREEN_TEXT_MAX_LENGTH).optional(),
  })
  .refine(
    (segment) =>
      segment.startMs === undefined ||
      segment.endMs === undefined ||
      segment.endMs > segment.startMs,
    { message: "A segment must end after it starts", path: ["endMs"] },
  );
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;

/**
 * A script: 1 to 60 segments with distinct ids. Timed segments must not overlap and must run in
 * order.
 */
export const ScriptSchema = z
  .object({
    title: z.string().trim().min(1).max(SCRIPT_TITLE_MAX_LENGTH),
    /** The opening line, spoken in the first segment. */
    hook: plainText(SCRIPT_HOOK_MAX_LENGTH, { min: 1 }),
    segments: z.array(ScriptSegmentSchema).min(1).max(SCRIPT_MAX_SEGMENTS),
    /** The closing call to action; may be empty. */
    cta: plainText(SCRIPT_CTA_MAX_LENGTH),
    /** The post caption, without hashtags. */
    caption: plainText(CAPTION_MAX_LENGTH),
    hashtags: HashtagsSchema,
    estimatedDurationMs: z.number().int().min(1).max(MAX_TIMELINE_MS),
  })
  .superRefine((script, ctx) => {
    if (hasDuplicates(script.segments.map((segment) => segment.id))) {
      ctx.addIssue({ code: "custom", message: "Segment ids must not repeat", path: ["segments"] });
    }
    let previousEnd = 0;
    script.segments.forEach((segment, index) => {
      if (segment.startMs !== undefined && segment.startMs < previousEnd) {
        ctx.addIssue({
          code: "custom",
          message: "Segments must not overlap and must run in order",
          path: ["segments", index, "startMs"],
        });
      }
      previousEnd = segment.endMs ?? segment.startMs ?? previousEnd;
    });
  });
export type Script = z.infer<typeof ScriptSchema>;

/**
 * One card on screen from `startMs` to `endMs`, while segment `segmentId` is spoken. `slots` fills
 * the card's named text slots.
 */
export const StoryboardFrameSchema = z
  .object({
    id: ArtifactIdSchema,
    segmentId: ArtifactIdSchema,
    startMs: TimeMsSchema,
    endMs: TimeMsSchema,
    cardId: CardIdSchema,
    slots: z
      .record(SlotNameSchema, plainText(SLOT_TEXT_MAX_LENGTH))
      .refine((slots) => Object.keys(slots).length <= FRAME_MAX_SLOTS, {
        message: `A frame fills at most ${FRAME_MAX_SLOTS} slots`,
      }),
    notes: plainText(FRAME_NOTES_MAX_LENGTH).optional(),
  })
  .refine((frame) => frame.endMs > frame.startMs, {
    message: "A frame must end after it starts",
    path: ["endMs"],
  });
export type StoryboardFrame = z.infer<typeof StoryboardFrameSchema>;

/**
 * A vertical storyboard at 30 fps: 1 to 80 frames with distinct ids, in time order and without
 * overlaps (gaps are allowed). Total slot text is capped at 100,000 characters.
 */
export const StoryboardSchema = z
  .object({
    styleId: StyleIdSchema,
    fps: z.literal(STORYBOARD_FPS),
    aspect: z.literal(STORYBOARD_ASPECT),
    frames: z.array(StoryboardFrameSchema).min(1).max(STORYBOARD_MAX_FRAMES),
  })
  .superRefine((storyboard, ctx) => {
    if (hasDuplicates(storyboard.frames.map((frame) => frame.id))) {
      ctx.addIssue({ code: "custom", message: "Frame ids must not repeat", path: ["frames"] });
    }
    storyboard.frames.forEach((frame, index) => {
      const previous = storyboard.frames[index - 1];
      if (previous && frame.startMs < previous.endMs) {
        ctx.addIssue({
          code: "custom",
          message: "Frames must not overlap and must run in order",
          path: ["frames", index, "startMs"],
        });
      }
    });
    const slotText = storyboard.frames
      .flatMap((frame) => Object.values(frame.slots))
      .reduce((total, text) => total + text.length, 0);
    if (slotText > STORYBOARD_MAX_SLOT_TEXT) {
      ctx.addIssue({
        code: "custom",
        message: `Slot text must total at most ${STORYBOARD_MAX_SLOT_TEXT} characters`,
        path: ["frames"],
      });
    }
  });
export type Storyboard = z.infer<typeof StoryboardSchema>;

/** One spoken word and when it is heard. */
export const AlignedWordSchema = z
  .object({
    text: z.string().min(1).max(ALIGNED_WORD_MAX_LENGTH).refine(isPlainText, {
      message: "The word contains control characters",
    }),
    startMs: TimeMsSchema,
    endMs: TimeMsSchema,
  })
  .refine((word) => word.endMs >= word.startMs, {
    message: "A word must not end before it starts",
    path: ["endMs"],
  });
export type AlignedWord = z.infer<typeof AlignedWordSchema>;

/** Word timings of a voice take, at most 5,000 words, in the order they are spoken. */
export const VoiceAlignmentSchema = z
  .object({
    words: z.array(AlignedWordSchema).max(ALIGNMENT_MAX_WORDS),
  })
  .superRefine((alignment, ctx) => {
    alignment.words.forEach((word, index) => {
      const previous = alignment.words[index - 1];
      if (previous && word.startMs < previous.startMs) {
        ctx.addIssue({
          code: "custom",
          message: "Words must be in the order they are spoken",
          path: ["words", index, "startMs"],
        });
      }
    });
  });
export type VoiceAlignment = z.infer<typeof VoiceAlignmentSchema>;
