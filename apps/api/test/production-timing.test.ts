import { type AlignedWord, StoryboardSchema } from "@loomcast/contracts";
import { describe, expect, it } from "vitest";
import {
  fitStoryboard,
  renderLengthNote,
  segmentSpans,
  timeScript,
} from "../src/modules/production";
import { script, storyboard } from "./pipeline-support";

/** Word timings for `texts`, `stepMs` per word, with `pauseMs` between segments. */
function spoken(texts: readonly string[], stepMs: number, pauseMs: number): AlignedWord[] {
  const words: AlignedWord[] = [];
  let at = 0;
  texts.forEach((text, index) => {
    if (index > 0) at += pauseMs;
    for (const word of text.split(/\s+/)) {
      words.push({ text: word, startMs: at, endMs: at + stepMs - 50 });
      at += stepMs;
    }
  });
  return words;
}

const SEGMENTS = script().segments.map((segment) => segment.text);

describe("segment timing from the voice alignment", () => {
  it("pairs words by position and times each segment from its first to its last word", () => {
    // Six words at 400 ms, a 600 ms pause, then nine words at 350 ms.
    const words = [...spoken([SEGMENTS[0] ?? ""], 400, 0), ...spoken([SEGMENTS[1] ?? ""], 350, 0)];
    const shifted = words.map((word, index) =>
      index < 6 ? word : { ...word, startMs: word.startMs + 3_000, endMs: word.endMs + 3_000 },
    );
    expect(segmentSpans(script(), shifted, 6_500)).toEqual([
      { id: "s1", startMs: 0, endMs: 2_350 },
      { id: "s2", startMs: 3_000, endMs: 6_100 },
    ]);
  });

  it("matches words through inserted and normalised words", () => {
    const words = spoken(SEGMENTS, 300, 500);
    // The provider adds a word in the first segment and changes the case and punctuation.
    words.splice(2, 0, { text: "uh", startMs: words[1]?.endMs ?? 0, endMs: words[1]?.endMs ?? 0 });
    words[0] = { ...(words[0] as AlignedWord), text: "EVERY," };
    const spans = segmentSpans(script(), words, 6_000);
    expect(spans[0]?.startMs).toBe(0);
    expect(spans[1]?.startMs).toBeGreaterThan(spans[0]?.endMs ?? 0);
    expect(spans[1]?.endMs).toBe(words.at(-1)?.endMs);
  });

  it("shares the take by word count when nothing matches", () => {
    const spans = segmentSpans(script(), [], 15_000);
    // Six and nine words over 15 s.
    expect(spans).toEqual([
      { id: "s1", startMs: 0, endMs: 6_000 },
      { id: "s2", startMs: 6_000, endMs: 15_000 },
    ]);
  });

  it("writes the times into the script", () => {
    const timed = timeScript(script(), spoken(SEGMENTS, 400, 500), 7_000);
    expect(timed?.segments.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
      [0, 2_350],
      [2_900, 6_450],
    ]);
  });
});

describe("re-timing a storyboard to the voice", () => {
  const spans = [
    { id: "s1", startMs: 0, endMs: 2_350 },
    { id: "s2", startMs: 3_000, endMs: 6_100 },
  ];

  it("maps each segment's frames onto its spoken time and ends with the voice", () => {
    // Cut from the script's estimate: 8 s, but the voice is 6.5 s.
    const fitted = fitStoryboard(storyboard(), spans, 6_500);
    expect(fitted.frames.map(({ id, startMs, endMs }) => [id, startMs, endMs])).toEqual([
      ["f1", 0, 3_000],
      ["f2", 3_000, 6_500],
    ]);
    expect(StoryboardSchema.safeParse(fitted).success).toBe(true);
  });

  it("keeps several frames of one segment in proportion and stretches a short storyboard", () => {
    const board = storyboard({
      frames: [
        { id: "a", segmentId: "s1", startMs: 0, endMs: 1_000, cardId: "title-card", slots: {} },
        { id: "b", segmentId: "s1", startMs: 1_000, endMs: 2_000, cardId: "quote", slots: {} },
        { id: "c", segmentId: "s2", startMs: 2_000, endMs: 3_000, cardId: "quote", slots: {} },
      ],
    });
    const fitted = fitStoryboard(board, spans, 9_000);
    expect(fitted.frames.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
      [0, 1_500],
      [1_500, 3_000],
      [3_000, 9_000],
    ]);
  });

  it("scales the whole storyboard when the frames do not follow the segments", () => {
    const board = storyboard({
      frames: [
        { id: "a", segmentId: "s2", startMs: 0, endMs: 4_000, cardId: "title-card", slots: {} },
        { id: "b", segmentId: "s1", startMs: 4_000, endMs: 8_000, cardId: "quote", slots: {} },
      ],
    });
    const fitted = fitStoryboard(board, spans, 6_000);
    expect(fitted.frames.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
      [0, 3_000],
      [3_000, 6_000],
    ]);
  });
});

describe("render length", () => {
  it("flags renders more than 10% outside the format's length", () => {
    const length = { min: 30, max: 60 };
    expect(renderLengthNote(45_000, length)).toBeNull();
    expect(renderLengthNote(27_000, length)).toBeNull();
    expect(renderLengthNote(66_000, length)).toBeNull();
    expect(renderLengthNote(26_900, length)).toMatch(/shorter than the format's 30–60 s/);
    expect(renderLengthNote(66_100, length)).toMatch(/runs 66.1 s, longer/);
  });
});
