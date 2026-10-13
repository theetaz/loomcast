import type { Script } from "@loomcast/contracts";
import { diffWords } from "diff";

/** A run of text that both versions share, or that only one of them has. */
export interface DiffPart {
  kind: "same" | "added" | "removed";
  text: string;
}

/**
 * The words a reader compares: the hook, each segment as its own paragraph and the call to
 * action. Timings and ids are left out, so re-recording a voice is not a change.
 */
export function scriptText(script: Pick<Script, "hook" | "segments" | "cta">): string {
  return [
    `Hook: ${script.hook}`,
    ...script.segments.map((segment) =>
      segment.onScreenText ? `${segment.text}\n[On screen: ${segment.onScreenText}]` : segment.text,
    ),
    script.cta ? `CTA: ${script.cta}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A word diff from `before` to `after`, with neighbouring parts of one kind merged. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const parts: DiffPart[] = [];
  for (const change of diffWords(before, after)) {
    const kind = change.added ? "added" : change.removed ? "removed" : "same";
    const last = parts.at(-1);
    if (last && last.kind === kind) last.text += change.value;
    else parts.push({ kind, text: change.value });
  }
  return parts;
}

/** Words added and removed, for the summary above a diff. */
export function diffStats(parts: readonly DiffPart[]): { added: number; removed: number } {
  const count = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
  return parts.reduce(
    (stats, part) => ({
      added: stats.added + (part.kind === "added" ? count(part.text) : 0),
      removed: stats.removed + (part.kind === "removed" ? count(part.text) : 0),
    }),
    { added: 0, removed: 0 },
  );
}
