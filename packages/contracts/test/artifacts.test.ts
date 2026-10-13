import { describe, expect, it } from "vitest";
import {
  ALIGNMENT_MAX_WORDS,
  CAPTION_MAX_LENGTH,
  SCRIPT_MAX_SEGMENTS,
  ScriptSchema,
  STORYBOARD_MAX_FRAMES,
  STORYBOARD_MAX_SLOT_TEXT,
  StoryboardSchema,
  VoiceAlignmentSchema,
} from "../src";
import { alignment, script, storyboard } from "./fixtures";

/** The element at `index`, failing the test when it is missing. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`No item at ${index}`);
  return item;
}

const frame = nth(storyboard.frames, 0);

/** `count` back-to-back frames of `ms` each. */
function frames(count: number, ms = 1_000) {
  return Array.from({ length: count }, (_, index) => ({
    ...frame,
    id: `f${index + 1}`,
    startMs: index * ms,
    endMs: (index + 1) * ms,
  }));
}

function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
}

describe("script", () => {
  it("accepts a script and normalises hashtags", () => {
    expect(ScriptSchema.parse(script)).toEqual(script);
    expect(ScriptSchema.parse({ ...script, hashtags: ["#RustLang"] }).hashtags).toEqual([
      "RustLang",
    ]);
  });

  it("caps segments and requires at least one", () => {
    const segments = Array.from({ length: SCRIPT_MAX_SEGMENTS + 1 }, (_, index) => ({
      id: `s${index}`,
      text: "Line.",
    }));

    expect(ScriptSchema.safeParse({ ...script, segments: segments.slice(1) }).success).toBe(true);
    expect(ScriptSchema.safeParse({ ...script, segments }).success).toBe(false);
    expect(ScriptSchema.safeParse({ ...script, segments: [] }).success).toBe(false);
  });

  it("rejects repeated segment ids and blank segments", () => {
    const first = nth(script.segments, 0);
    const second = nth(script.segments, 1);

    expect(
      ScriptSchema.safeParse({ ...script, segments: [first, { ...second, id: first.id }] }).success,
    ).toBe(false);
    expect(
      ScriptSchema.safeParse({ ...script, segments: [{ ...first, text: "  " }] }).success,
    ).toBe(false);
    expect(
      ScriptSchema.safeParse({ ...script, segments: [{ ...first, id: "bad id" }] }).success,
    ).toBe(false);
  });

  it("keeps timed segments in order", () => {
    const timed = (ranges: [number, number][]) =>
      ScriptSchema.safeParse({
        ...script,
        segments: ranges.map(([startMs, endMs], index) => ({
          id: `s${index}`,
          text: "Line.",
          startMs,
          endMs,
        })),
      });

    expect(
      timed([
        [0, 1_000],
        [1_000, 2_500],
      ]).success,
    ).toBe(true);
    expect(
      issuePaths(
        timed([
          [0, 1_000],
          [900, 2_000],
        ]),
      ),
    ).toEqual(["segments.1.startMs"]);
    expect(timed([[1_000, 1_000]]).success).toBe(false);
  });

  it("bounds the caption and rejects control characters", () => {
    expect(
      ScriptSchema.safeParse({ ...script, caption: "x".repeat(CAPTION_MAX_LENGTH) }).success,
    ).toBe(true);
    expect(
      ScriptSchema.safeParse({ ...script, caption: "x".repeat(CAPTION_MAX_LENGTH + 1) }).success,
    ).toBe(false);
    expect(ScriptSchema.safeParse({ ...script, hook: "Stop\u0000here" }).success).toBe(false);
  });
});

describe("storyboard", () => {
  it("accepts a vertical 30 fps storyboard", () => {
    expect(StoryboardSchema.parse(storyboard)).toEqual(storyboard);
    expect(StoryboardSchema.safeParse({ ...storyboard, fps: 60 }).success).toBe(false);
    expect(StoryboardSchema.safeParse({ ...storyboard, aspect: "16:9" }).success).toBe(false);
  });

  it("requires frames in time order without overlaps", () => {
    const [first, second] = frames(2);

    expect(StoryboardSchema.safeParse({ ...storyboard, frames: [first, second] }).success).toBe(
      true,
    );
    // Gaps between frames are fine.
    expect(
      StoryboardSchema.safeParse({
        ...storyboard,
        frames: [first, { ...second, startMs: 1_500, endMs: 2_500 }],
      }).success,
    ).toBe(true);
    expect(
      issuePaths(StoryboardSchema.safeParse({ ...storyboard, frames: [second, first] })),
    ).toEqual(["frames.1.startMs"]);
    expect(
      issuePaths(
        StoryboardSchema.safeParse({
          ...storyboard,
          frames: [first, { ...second, startMs: 999 }],
        }),
      ),
    ).toEqual(["frames.1.startMs"]);
  });

  it("rejects empty frames and repeated frame ids", () => {
    const first = nth(frames(2), 0);
    const second = nth(frames(2), 1);

    expect(
      StoryboardSchema.safeParse({ ...storyboard, frames: [{ ...first, endMs: first.startMs }] })
        .success,
    ).toBe(false);
    expect(
      StoryboardSchema.safeParse({ ...storyboard, frames: [first, { ...second, id: first.id }] })
        .success,
    ).toBe(false);
  });

  it("caps frames, slots and slot text", () => {
    expect(
      StoryboardSchema.safeParse({ ...storyboard, frames: frames(STORYBOARD_MAX_FRAMES) }).success,
    ).toBe(true);
    expect(
      StoryboardSchema.safeParse({ ...storyboard, frames: frames(STORYBOARD_MAX_FRAMES + 1) })
        .success,
    ).toBe(false);
    expect(StoryboardSchema.safeParse({ ...storyboard, frames: [] }).success).toBe(false);

    const slots = (count: number, length = 10) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`slot${i}`, "x".repeat(length)]));
    const withSlots = (value: Record<string, string>, count = 1) =>
      StoryboardSchema.safeParse({
        ...storyboard,
        frames: frames(count).map((item) => ({ ...item, slots: value })),
      }).success;

    expect(withSlots(slots(32))).toBe(true);
    expect(withSlots(slots(33))).toBe(false);
    expect(withSlots({ headline: "x".repeat(281) })).toBe(false);
    expect(withSlots({ "not a slot": "x" })).toBe(false);
    // 80 frames of 5 full slots is 112,000 characters: over the total.
    expect(withSlots(slots(5, 280), STORYBOARD_MAX_FRAMES)).toBe(false);
    expect(5 * 280 * STORYBOARD_MAX_FRAMES).toBeGreaterThan(STORYBOARD_MAX_SLOT_TEXT);
  });

  it("checks style and card ids for shape only", () => {
    expect(StoryboardSchema.safeParse({ ...storyboard, styleId: "kallaway" }).success).toBe(true);
    expect(StoryboardSchema.safeParse({ ...storyboard, styleId: "Vox Explainer" }).success).toBe(
      false,
    );
    expect(
      StoryboardSchema.safeParse({
        ...storyboard,
        frames: [{ ...frame, cardId: "../cards/t1.html" }],
      }).success,
    ).toBe(false);
  });
});

describe("voice alignment", () => {
  it("accepts words in spoken order", () => {
    expect(VoiceAlignmentSchema.parse(alignment)).toEqual(alignment);
    expect(VoiceAlignmentSchema.parse({ words: [] })).toEqual({ words: [] });
  });

  it("rejects words out of order or ending before they start", () => {
    const first = nth(alignment.words, 0);
    const second = nth(alignment.words, 1);

    expect(VoiceAlignmentSchema.safeParse({ words: [second, first] }).success).toBe(false);
    expect(
      VoiceAlignmentSchema.safeParse({ words: [{ ...first, endMs: first.startMs - 1 }] }).success,
    ).toBe(false);
  });

  it("caps the number of words", () => {
    const words = Array.from({ length: ALIGNMENT_MAX_WORDS + 1 }, (_, index) => ({
      text: "word",
      startMs: index * 10,
      endMs: index * 10 + 5,
    }));

    expect(VoiceAlignmentSchema.safeParse({ words: words.slice(1) }).success).toBe(true);
    expect(VoiceAlignmentSchema.safeParse({ words }).success).toBe(false);
  });
});
