import type { LengthSec, Script, ScriptSegment, StoryboardFrame } from "@loomcast/contracts";

/** Words per second at a voice speed of 1, a little slower than conversation. */
export const WORDS_PER_SECOND = 2.5;

/** A time on the timeline as `mm:ss.t`, such as `00:03.2`. */
export function formatTimecode(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
}

/** A span as `[00:03.2–00:07.9]`. */
export function formatSpan(startMs: number, endMs: number): string {
  return `[${formatTimecode(startMs)}–${formatTimecode(endMs)}]`;
}

/** A length in seconds for sentences: `42 s`, `1 min 5 s`. */
export function formatSeconds(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Words spoken in a script: its segments (the hook is spoken in the first one). */
export function scriptWords(script: Pick<Script, "segments">): number {
  return script.segments.reduce((total, segment) => total + countWords(segment.text), 0);
}

/** How long `words` take to say at `speed`. */
export function estimateMs(words: number, speed = 1): number {
  return Math.round((words / (WORDS_PER_SECOND * speed)) * 1000);
}

export interface TimedSegment {
  segment: ScriptSegment;
  startMs: number;
  endMs: number;
  /** True when the times come from the voice; false when estimated from the word count. */
  measured: boolean;
}

/**
 * Every segment with a start and end: the voice timings when the segment has them, otherwise an
 * estimate from its words that carries on from the previous segment.
 */
export function timeSegments(segments: readonly ScriptSegment[], speed = 1): TimedSegment[] {
  let at = 0;
  return segments.map((segment) => {
    if (segment.startMs !== undefined && segment.endMs !== undefined) {
      at = segment.endMs;
      return { segment, startMs: segment.startMs, endMs: segment.endMs, measured: true };
    }
    const startMs = segment.startMs ?? at;
    const endMs = startMs + estimateMs(countWords(segment.text), speed);
    at = endMs;
    return { segment, startMs, endMs, measured: false };
  });
}

/** The script's length: the end of the last voiced segment, or the estimate from its words. */
export function scriptDuration(script: Pick<Script, "segments">, speed = 1) {
  const timed = timeSegments(script.segments, speed);
  const measured = timed.length > 0 && timed.every((entry) => entry.measured);
  return { ms: timed.at(-1)?.endMs ?? 0, measured };
}

export type TargetFit = "under" | "within" | "over";

/** Where a length falls against the format's target range. */
export function fitTarget(ms: number, target: LengthSec): { fit: TargetFit; byMs: number } {
  if (ms < target.min * 1000) return { fit: "under", byMs: target.min * 1000 - ms };
  if (ms > target.max * 1000) return { fit: "over", byMs: ms - target.max * 1000 };
  return { fit: "within", byMs: 0 };
}

/**
 * The parts of a card id such as `vox-explainer.t1.section.circle`: style, tier and purpose. Ids
 * that don't follow the pattern keep only what can be read.
 */
export function parseCardId(cardId: string): {
  style: string;
  tier: string | null;
  purpose: string | null;
} {
  const [style = cardId, tier, purpose] = cardId.split(".");
  const tierMatch = tier ? /^t(\d+)$/.exec(tier) : null;
  return {
    style,
    tier: tierMatch ? `Tier ${tierMatch[1]}` : (tier ?? null),
    purpose: purpose ? purpose.replace(/[-_]/g, " ") : null,
  };
}

/** Where a frame sits on the timeline, as fractions of the whole: for the timing bar. */
export function frameBar(
  frame: Pick<StoryboardFrame, "startMs" | "endMs">,
  totalMs: number,
): { left: number; width: number } {
  if (totalMs <= 0) return { left: 0, width: 0 };
  const left = Math.min(1, frame.startMs / totalMs);
  const width = Math.max(0, Math.min(1 - left, (frame.endMs - frame.startMs) / totalMs));
  return { left, width };
}
