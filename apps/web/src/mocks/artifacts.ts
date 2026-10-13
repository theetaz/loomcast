import type { Script, ScriptSegment, Storyboard, StoryboardFrame } from "@loomcast/contracts";

// Realistic scripts and storyboards for mock versions, so the item page has something to show.
// Each version number gets slightly different wording, which makes version diffs readable.

/** Words per second the mock voice speaks at, close to a brisk narrator. */
const WORDS_PER_SECOND = 2.6;

const HOOKS = [
  "This loop compiles in every language you know. Rust refuses it.",
  "This loop compiles everywhere else. Rust says no, and it is right.",
  "Every language runs this loop. Rust stops it before it ever runs.",
];

interface SegmentDraft {
  id: string;
  text: string[];
  onScreenText?: string;
}

const SEGMENTS: SegmentDraft[] = [
  {
    id: "hook",
    text: HOOKS,
    onScreenText: "error[E0502]",
  },
  {
    id: "setup",
    text: [
      "We push to a vector while we iterate over it. Looks harmless.",
      "We push to a vector while iterating over it. It looks harmless.",
    ],
    onScreenText: "for x in &v { v.push(x) }",
  },
  {
    id: "why",
    text: [
      "The loop holds a shared borrow of the vector. Pushing needs a mutable one, and the two can not overlap.",
      "The loop borrows the vector to read it. Pushing needs to change it, and Rust never lets both happen at once.",
    ],
    onScreenText: "&v and &mut v can't overlap",
  },
  {
    id: "danger",
    text: [
      "If it were allowed, a push could move the buffer and leave the loop reading freed memory.",
    ],
  },
  {
    id: "fix",
    text: [
      "Collect what you want to add first, then extend the vector after the loop ends.",
      "Collect the new items first, then extend the vector once the loop is done.",
    ],
    onScreenText: "v.extend(extra)",
  },
  {
    id: "payoff",
    text: [
      "One borrow at a time. That rule is the whole trick.",
      "One borrow at a time. That is the whole rule.",
    ],
    onScreenText: "One borrow at a time",
  },
];

function pick<T>(options: readonly T[], variant: number): T {
  return options[variant % options.length] as T;
}

/** Words in a piece of text, as the script view counts them. */
function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * A script for a short. `variant` (the version number) changes some of the wording; `timed` adds
 * segment timings, as a version with a voice has.
 */
export function mockScript(variant = 1, { timed = false }: { timed?: boolean } = {}): Script {
  let at = 0;
  const segments: ScriptSegment[] = SEGMENTS.map((draft) => {
    const text = pick(draft.text, variant);
    const duration = Math.round((words(text) / WORDS_PER_SECOND) * 1000);
    const segment: ScriptSegment = {
      id: draft.id,
      text,
      ...(draft.onScreenText ? { onScreenText: draft.onScreenText } : {}),
      ...(timed ? { startMs: at, endMs: at + duration } : {}),
    };
    at += duration + (timed ? 250 : 0);
    return segment;
  });
  const total = segments.reduce((sum, segment) => sum + words(segment.text), 0);
  return {
    title: "Why the borrow checker rejects this loop",
    hook: pick(HOOKS, variant),
    segments,
    cta: "Follow for one Rust rule a day.",
    caption: "The borrow checker is not being difficult: it is stopping a use-after-free.",
    hashtags: ["rust", "rustlang", "programming"],
    estimatedDurationMs: Math.round((total / WORDS_PER_SECOND) * 1000),
  };
}

/** Cards from the studio's vox-explainer style, with the slots each one fills. */
const CARDS: { cardId: string; slots: (segment: ScriptSegment) => Record<string, string> }[] = [
  {
    cardId: "vox-explainer.t1.section.circle",
    slots: (segment) => ({
      kicker: "Rust in 60 seconds",
      headline: segment.onScreenText ?? "The borrow checker",
    }),
  },
  {
    cardId: "vox-explainer.t2.label.margin-note",
    slots: (segment) => ({ term: segment.onScreenText ?? "Borrow", detail: "Shared borrow" }),
  },
  {
    cardId: "vox-explainer.t1.section.markerbox",
    slots: (segment) => ({
      kicker: "Why",
      line1: "Reading borrows it",
      line2: "Pushing changes it",
      line3: segment.onScreenText ?? "Never both",
    }),
  },
  {
    cardId: "vox-explainer.t1.stat.circle",
    slots: () => ({ kicker: "Without the rule", stat: "1", label: "dangling pointer" }),
  },
  {
    cardId: "vox-explainer.t2.lower-third.marker",
    slots: (segment) => ({ tag: "Fix", name: segment.onScreenText ?? "extend", role: "after" }),
  },
  {
    cardId: "vox-explainer.t1.section.circle",
    slots: (segment) => ({ kicker: "Remember", headline: segment.onScreenText ?? "One at a time" }),
  },
];

/** A 30 fps vertical storyboard with one frame per segment of `script`. */
export function mockStoryboard(script: Script): Storyboard {
  let at = 0;
  const frames: StoryboardFrame[] = script.segments.map((segment, index) => {
    const card = pick(CARDS, index);
    const startMs = segment.startMs ?? at;
    const endMs =
      segment.endMs ?? startMs + Math.round((words(segment.text) / WORDS_PER_SECOND) * 1000);
    at = endMs;
    return {
      id: `frame-${String(index + 1).padStart(2, "0")}`,
      segmentId: segment.id,
      startMs,
      endMs,
      cardId: card.cardId,
      slots: card.slots(segment),
    };
  });
  return { styleId: "vox-explainer", fps: 30, aspect: "9:16", frames };
}
