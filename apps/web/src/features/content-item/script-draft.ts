import { type Script, ScriptSchema, type ScriptSegment } from "@loomcast/contracts";
import { estimateMs, scriptWords } from "./timing";

/** One segment being edited. `key` stays with the segment while it moves. */
export interface SegmentDraft {
  key: string;
  id: string;
  text: string;
  onScreenText: string;
}

export interface ScriptDraft {
  hook: string;
  segments: SegmentDraft[];
  cta: string;
  caption: string;
}

let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `segment-${keyCounter}`;
}

export function draftFromScript(script: Script): ScriptDraft {
  return {
    hook: script.hook,
    segments: script.segments.map((segment) => ({
      key: nextKey(),
      id: segment.id,
      text: segment.text,
      onScreenText: segment.onScreenText ?? "",
    })),
    cta: script.cta,
    caption: script.caption,
  };
}

/** The first `s<n>` id no segment uses. */
export function newSegmentId(segments: readonly Pick<SegmentDraft, "id">[]): string {
  const taken = new Set(segments.map((segment) => segment.id));
  let n = segments.length + 1;
  while (taken.has(`s${n}`)) n += 1;
  return `s${n}`;
}

/** A blank segment for after `index` (or at the start for -1). */
export function insertSegment(segments: readonly SegmentDraft[], index: number) {
  const segment: SegmentDraft = {
    key: nextKey(),
    id: newSegmentId(segments),
    text: "",
    onScreenText: "",
  };
  const next = [...segments];
  next.splice(index + 1, 0, segment);
  return { segments: next, segment };
}

/** Moves the segment at `index` by `delta` places; out-of-range moves change nothing. */
export function moveSegment(
  segments: readonly SegmentDraft[],
  index: number,
  delta: -1 | 1,
): SegmentDraft[] {
  const target = index + delta;
  if (index < 0 || index >= segments.length || target < 0 || target >= segments.length) {
    return [...segments];
  }
  const next = [...segments];
  const [moved] = next.splice(index, 1);
  if (moved) next.splice(target, 0, moved);
  return next;
}

export function removeSegment(segments: readonly SegmentDraft[], index: number): SegmentDraft[] {
  if (segments.length <= 1) return [...segments];
  return segments.filter((_, position) => position !== index);
}

/**
 * The script to save. Timings come from a voice, and a changed script loses its voice, so they
 * are dropped; the estimated length follows the new words. Title and hashtags carry over.
 */
export function scriptFromDraft(draft: ScriptDraft, base: Script): Script {
  const segments: ScriptSegment[] = draft.segments.map((segment) => {
    const onScreenText = segment.onScreenText.trim();
    return {
      id: segment.id,
      text: segment.text.trim(),
      ...(onScreenText ? { onScreenText } : {}),
    };
  });
  return {
    title: base.title,
    hook: draft.hook.trim(),
    segments,
    cta: draft.cta.trim(),
    caption: draft.caption.trim(),
    hashtags: base.hashtags,
    estimatedDurationMs: Math.max(1, estimateMs(scriptWords({ segments }))),
  };
}

/** Whether the draft says anything different from `base` (timings aside). */
export function isDraftChanged(draft: ScriptDraft, base: Script): boolean {
  const saved = scriptFromDraft(draftFromScript(base), base);
  const edited = scriptFromDraft(draft, base);
  return JSON.stringify(saved) !== JSON.stringify(edited);
}

/** The first problem with the draft, in words that name the field. */
export function validateDraft(draft: ScriptDraft, base: Script): string | null {
  const result = ScriptSchema.safeParse(scriptFromDraft(draft, base));
  if (result.success) return null;
  const issue = result.error.issues[0];
  if (!issue) return "Check the script.";
  const [field, index] = issue.path;
  if (field === "segments" && typeof index === "number") {
    return `Segment ${index + 1}: ${issue.message}`;
  }
  if (field === "hook") return `Hook: ${issue.message}`;
  if (field === "cta") return `Call to action: ${issue.message}`;
  if (field === "caption") return `Caption: ${issue.message}`;
  return issue.message;
}
