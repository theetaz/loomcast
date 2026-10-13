import {
  type AlignedWord,
  type LengthSec,
  MAX_TIMELINE_MS,
  type Script,
  ScriptSchema,
  type Storyboard,
  type StoryboardFrame,
  StoryboardSchema,
} from "@loomcast/contracts";

// Timing of a content version against its real voice take. The pipeline order is fixed by the
// contracts (script, storyboard, voice, render), so the storyboard is cut before the voice exists
// and its frames are timed from the script's estimate. Once the voice is in, the server times the
// script's segments from the word alignment and re-times the storyboard to them, so the render
// never sees frames that run past the voice.

/** How far a look-ahead may skip alignment words that match no script word (inserted words). */
const MATCH_WINDOW = 12;

/** A segment's spoken time span. */
export interface SegmentSpan {
  id: string;
  startMs: number;
  endMs: number;
}

/** A word as compared between the script and the alignment: lowercase letters and digits only. */
export function normalizeToken(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function tokens(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeToken)
    .filter((token) => token.length > 0);
}

function clampMs(value: number): number {
  return Math.min(MAX_TIMELINE_MS, Math.max(0, Math.round(value)));
}

/**
 * Which alignment words belong to each segment, as `[first, last]` indexes or null when none
 * matched. When the alignment has exactly as many words as the script, words are paired by
 * position (the studio agent speaks the segments' words in order). Otherwise each script word is
 * looked up in a short window after the last match, so inserted or dropped words only cost a
 * local mismatch.
 */
function matchSegments(
  segments: readonly { text: string }[],
  words: readonly AlignedWord[],
): ([number, number] | null)[] {
  const segmentTokens = segments.map((segment) => tokens(segment.text));
  const spoken = words
    .map((word, index) => ({ token: normalizeToken(word.text), index }))
    .filter((word) => word.token.length > 0);
  const total = segmentTokens.reduce((sum, list) => sum + list.length, 0);

  if (total === spoken.length) {
    let position = 0;
    return segmentTokens.map((list) => {
      if (list.length === 0) return null;
      const first = spoken[position]?.index;
      position += list.length;
      const last = spoken[position - 1]?.index;
      return first === undefined || last === undefined ? null : [first, last];
    });
  }

  let cursor = 0;
  return segmentTokens.map((list) => {
    let first: number | null = null;
    let last: number | null = null;
    for (const token of list) {
      const end = Math.min(spoken.length, cursor + MATCH_WINDOW);
      for (let j = cursor; j < end; j++) {
        if (spoken[j]?.token === token) {
          const index = spoken[j]?.index ?? 0;
          first ??= index;
          last = index;
          cursor = j + 1;
          break;
        }
      }
    }
    return first === null || last === null ? null : [first, last];
  });
}

/**
 * The spoken span of every segment of `script`, from the voice's word alignment. Segments whose
 * words could not be matched share the time between their matched neighbours (or the start and
 * end of the take) in proportion to their word counts. Spans are in order, never overlap and
 * last at least 1 ms.
 */
export function segmentSpans(
  script: Pick<Script, "segments">,
  words: readonly AlignedWord[],
  durationMs: number,
): SegmentSpan[] {
  const matches = matchSegments(script.segments, words);
  const spans: (SegmentSpan | null)[] = script.segments.map((segment, index) => {
    const match = matches[index];
    if (match === null || match === undefined) return null;
    const first = words[match[0]];
    const last = words[match[1]];
    if (first === undefined || last === undefined) return null;
    return { id: segment.id, startMs: first.startMs, endMs: Math.max(last.endMs, first.startMs) };
  });

  // Fill each run of unmatched segments between the neighbours that matched.
  let index = 0;
  while (index < spans.length) {
    if (spans[index] !== null) {
      index++;
      continue;
    }
    let end = index;
    while (end < spans.length && spans[end] === null) end++;
    const from = spans[index - 1]?.endMs ?? 0;
    const to = Math.max(from, spans[end]?.startMs ?? durationMs);
    const weights = script.segments
      .slice(index, end)
      .map((segment) => Math.max(1, tokens(segment.text).length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let at = from;
    for (let k = index; k < end; k++) {
      const share = ((to - from) * (weights[k - index] ?? 1)) / totalWeight;
      const segment = script.segments[k];
      if (segment !== undefined) {
        spans[k] = { id: segment.id, startMs: at, endMs: at + share };
      }
      at += share;
    }
    index = end;
  }

  // Whole milliseconds, in order, without overlaps, each at least 1 ms long.
  let floor = 0;
  return spans.map((span, k) => {
    const id = span?.id ?? script.segments[k]?.id ?? "";
    const startMs = clampMs(Math.max(span?.startMs ?? floor, floor));
    const endMs = clampMs(Math.max(span?.endMs ?? startMs, startMs + 1));
    floor = endMs;
    return { id, startMs, endMs };
  });
}

/**
 * The script with each segment's `startMs` and `endMs` set from the voice alignment. Returns null
 * when the timed script would not pass the contract (the caller then keeps the script as it was).
 */
export function timeScript(
  script: Script,
  words: readonly AlignedWord[],
  durationMs: number,
): Script | null {
  const spans = segmentSpans(script, words, durationMs);
  const timed: Script = {
    ...script,
    segments: script.segments.map((segment, index) => ({
      ...segment,
      startMs: spans[index]?.startMs,
      endMs: spans[index]?.endMs,
    })),
  };
  const parsed = ScriptSchema.safeParse(timed);
  return parsed.success ? parsed.data : null;
}

/** The segment spans of a script whose segments all carry times, or null. */
export function spansOfScript(script: Script | null): SegmentSpan[] | null {
  if (script === null) return null;
  const spans: SegmentSpan[] = [];
  for (const segment of script.segments) {
    if (segment.startMs === undefined || segment.endMs === undefined) return null;
    spans.push({ id: segment.id, startMs: segment.startMs, endMs: segment.endMs });
  }
  return spans;
}

/** Frames with whole-millisecond times in order, each at least 1 ms long. */
function orderedFrames(frames: readonly StoryboardFrame[]): StoryboardFrame[] {
  let floor = 0;
  return frames.map((frame) => {
    const startMs = clampMs(Math.max(frame.startMs, floor));
    const endMs = clampMs(Math.max(frame.endMs, startMs + 1));
    floor = endMs;
    return { ...frame, startMs, endMs };
  });
}

function valid(storyboard: Storyboard): Storyboard | null {
  const parsed = StoryboardSchema.safeParse(storyboard);
  return parsed.success ? parsed.data : null;
}

/** Stretches every frame by the same factor so the last one ends with the voice. */
function scaleToVoice(storyboard: Storyboard, durationMs: number): Storyboard | null {
  const lastEnd = storyboard.frames.at(-1)?.endMs ?? 0;
  if (lastEnd <= 0) return null;
  const factor = durationMs / lastEnd;
  return valid({
    ...storyboard,
    frames: orderedFrames(
      storyboard.frames.map((frame) => ({
        ...frame,
        startMs: frame.startMs * factor,
        endMs: frame.endMs * factor,
      })),
    ),
  });
}

/**
 * Re-times a storyboard to the voice take. Frames are grouped by the segment they play over; each
 * group's stretch of the old timeline (from its first frame to the next group's first frame) is
 * mapped linearly onto the new one (from its segment's spoken start to the next group's segment
 * start). The first group starts at 0 and the last one ends with the voice, so the cards cover
 * the whole take, pauses included, and never run past it.
 *
 * When the frames do not follow the script's segments in order (an unknown segment id, or a
 * segment shown in two separate places), the whole storyboard is scaled instead. Returns the
 * storyboard unchanged if neither result passes the contract.
 */
export function fitStoryboard(
  storyboard: Storyboard,
  spans: readonly SegmentSpan[],
  durationMs: number,
): Storyboard {
  const order = new Map(spans.map((span, index) => [span.id, index]));
  const groups: { segment: number; frames: StoryboardFrame[] }[] = [];
  let inOrder = true;
  for (const frame of storyboard.frames) {
    const segment = order.get(frame.segmentId);
    const current = groups.at(-1);
    if (segment === undefined) {
      inOrder = false;
      break;
    }
    if (current !== undefined && current.segment === segment) {
      current.frames.push(frame);
    } else if (current === undefined || segment > current.segment) {
      groups.push({ segment, frames: [frame] });
    } else {
      inOrder = false;
      break;
    }
  }

  if (inOrder && groups.length > 0) {
    const frames: StoryboardFrame[] = [];
    groups.forEach((group, k) => {
      const next = groups[k + 1];
      const oldStart = group.frames[0]?.startMs ?? 0;
      const oldEnd = next?.frames[0]?.startMs ?? group.frames.at(-1)?.endMs ?? oldStart;
      const newStart = k === 0 ? 0 : (spans[group.segment]?.startMs ?? 0);
      const newEnd = Math.max(
        newStart + 1,
        next === undefined ? durationMs : (spans[next.segment]?.startMs ?? durationMs),
      );
      const scale = oldEnd > oldStart ? (newEnd - newStart) / (oldEnd - oldStart) : 0;
      const map = (t: number) => newStart + (t - oldStart) * scale;
      for (const frame of group.frames) {
        frames.push({ ...frame, startMs: map(frame.startMs), endMs: map(frame.endMs) });
      }
    });
    // The last frame ends with the voice, even when the old storyboard left a gap at its end.
    const last = frames.at(-1);
    if (last !== undefined) last.endMs = durationMs;
    const fitted = valid({ ...storyboard, frames: orderedFrames(frames) });
    if (fitted !== null) return fitted;
  }
  return scaleToVoice(storyboard, durationMs) ?? storyboard;
}

/** The share a render may run outside the format's length before it is flagged. */
export const RENDER_LENGTH_TOLERANCE = 0.1;

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1).replace(/\.0$/, "");
}

/**
 * A note for a render whose length is outside the format's `lengthSec` range by more than 10%,
 * or null when it fits. A render of the wrong length is flagged for the reviewer, never failed.
 */
export function renderLengthNote(durationMs: number, lengthSec: LengthSec): string | null {
  const shortest = lengthSec.min * 1000 * (1 - RENDER_LENGTH_TOLERANCE);
  const longest = lengthSec.max * 1000 * (1 + RENDER_LENGTH_TOLERANCE);
  if (durationMs >= shortest && durationMs <= longest) return null;
  const range =
    lengthSec.min === lengthSec.max ? `${lengthSec.min} s` : `${lengthSec.min}–${lengthSec.max} s`;
  return `The render runs ${seconds(durationMs)} s, ${durationMs < shortest ? "shorter" : "longer"} than the format's ${range} allows (with 10% tolerance).`;
}
