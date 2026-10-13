import { type Storyboard, StoryboardSchema } from "@loomcast/contracts";
import type { CardRegistry } from "./registry.ts";

// Validates a storyboard against the card registry the studio actually has. The contracts check
// shape only (ids, 30 fps, 9:16, ordered frames); this adds what needs the registry: cards and
// slots exist, slot text fits, and every frame stays on screen within its card's limits.

export type StoryboardIssueCode =
  | "invalid_storyboard"
  | "unknown_style"
  | "unknown_card"
  | "card_style_mismatch"
  | "unknown_slot"
  | "image_slot"
  | "slot_too_long"
  | "missing_slot"
  | "frame_order"
  | "frame_overlap"
  | "frame_too_short"
  | "frame_too_long"
  | "beyond_voice";

export interface StoryboardIssue {
  severity: "error" | "warning";
  code: StoryboardIssueCode;
  /** Where the issue is, such as `["frames", 2, "slots", "headline"]`. */
  path: (string | number)[];
  message: string;
}

export interface ValidateStoryboardOptions {
  /** The voice take's length; frames must not run past it (with 0.5 s of slack). */
  voiceDurationMs?: number;
}

const VOICE_SLACK_MS = 500;

interface LooseFrame {
  id?: unknown;
  startMs?: unknown;
  endMs?: unknown;
  cardId?: unknown;
  slots?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2).replace(/\.?0+$/, "")} s`;
}

function pathKey(path: readonly PropertyKey[]): string {
  return path.map(String).join(".");
}

/** Timing checks on the raw frames: in order and without overlaps. */
function timingIssues(frames: LooseFrame[]): StoryboardIssue[] {
  const issues: StoryboardIssue[] = [];
  let previous: { start: number; end: number } | undefined;
  frames.forEach((frame, index) => {
    const { startMs: start, endMs: end } = frame;
    if (typeof start !== "number" || typeof end !== "number") return;
    if (previous && start < previous.start) {
      issues.push({
        severity: "error",
        code: "frame_order",
        path: ["frames", index, "startMs"],
        message: `Frame ${index + 1} starts before the frame ahead of it; frames must run in order`,
      });
    } else if (previous && start < previous.end) {
      issues.push({
        severity: "error",
        code: "frame_overlap",
        path: ["frames", index, "startMs"],
        message: `Frame ${index + 1} starts at ${seconds(start)}, before the previous frame ends at ${seconds(previous.end)}`,
      });
    }
    previous = { start, end };
  });
  return issues;
}

/** Registry checks for one frame: the card, its slots and its time on screen. */
function frameIssues(
  frame: LooseFrame,
  index: number,
  styleId: unknown,
  registry: CardRegistry,
): StoryboardIssue[] {
  const issues: StoryboardIssue[] = [];
  if (typeof frame.cardId !== "string") return issues;
  const card = registry.getCard(frame.cardId);
  if (!card) {
    issues.push({
      severity: "error",
      code: "unknown_card",
      path: ["frames", index, "cardId"],
      message: `Card ${frame.cardId} is not in the style library`,
    });
    return issues;
  }
  if (typeof styleId === "string" && card.styleId !== styleId) {
    issues.push({
      severity: "error",
      code: "card_style_mismatch",
      path: ["frames", index, "cardId"],
      message: `Card ${card.id} belongs to style ${card.styleId}, not ${styleId}`,
    });
  }

  const slots = isRecord(frame.slots) ? frame.slots : {};
  const declared = new Map(card.slots.map((slot) => [slot.name, slot]));
  for (const [name, value] of Object.entries(slots)) {
    const slot = declared.get(name);
    const path = ["frames", index, "slots", name];
    if (!slot) {
      issues.push({
        severity: "error",
        code: "unknown_slot",
        path,
        message: `Card ${card.id} has no slot ${name}; use one of ${card.slots.map((s) => s.name).join(", ")}`,
      });
    } else if (slot.type === "image") {
      issues.push({
        severity: "error",
        code: "image_slot",
        path,
        message: `Slot ${name} of ${card.id} takes an image, not text; leave it out`,
      });
    } else if (typeof value === "string" && value.length > slot.maxChars) {
      issues.push({
        severity: "error",
        code: "slot_too_long",
        path,
        message: `Slot ${name} of ${card.id} takes at most ${slot.maxChars} characters (got ${value.length})`,
      });
    }
  }
  for (const slot of card.slots) {
    if (slot.type !== "image" && !(slot.name in slots)) {
      issues.push({
        severity: "warning",
        code: "missing_slot",
        path: ["frames", index, "slots"],
        message: `Slot ${slot.name} of ${card.id} is not filled and will render empty`,
      });
    }
  }

  if (typeof frame.startMs === "number" && typeof frame.endMs === "number") {
    const length = frame.endMs - frame.startMs;
    const { min, max } = card.duration;
    if (length < min * 1000) {
      issues.push({
        severity: "error",
        code: "frame_too_short",
        path: ["frames", index, "endMs"],
        message: `Card ${card.id} needs at least ${min} s on screen (frame is ${seconds(length)})`,
      });
    } else if (length > max * 1000) {
      issues.push({
        severity: "error",
        code: "frame_too_long",
        path: ["frames", index, "endMs"],
        message: `Card ${card.id} stays at most ${max} s on screen (frame is ${seconds(length)})`,
      });
    }
  }
  return issues;
}

/**
 * Checks a storyboard against the contract and the card registry. Returns every issue found; the
 * storyboard is renderable when none of them is an error.
 */
export function validateStoryboard(
  input: unknown,
  registry: CardRegistry,
  options: ValidateStoryboardOptions = {},
): StoryboardIssue[] {
  const issues: StoryboardIssue[] = [];
  const raw = isRecord(input) ? input : {};
  const frames: LooseFrame[] = Array.isArray(raw.frames) ? raw.frames.filter(isRecord) : [];

  issues.push(...timingIssues(frames));

  if (typeof raw.styleId === "string" && !registry.getStyle(raw.styleId)) {
    issues.push({
      severity: "error",
      code: "unknown_style",
      path: ["styleId"],
      message: `Style ${raw.styleId} is not in the style library`,
    });
  }

  frames.forEach((frame, index) => {
    issues.push(...frameIssues(frame, index, raw.styleId, registry));
  });

  // Contract issues the registry checks have not already explained in their own words.
  const reported = new Set(issues.map((issue) => pathKey(issue.path)));
  const parsed = StoryboardSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (reported.has(pathKey(issue.path))) continue;
      issues.push({
        severity: "error",
        code: "invalid_storyboard",
        path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
        message: issue.message,
      });
    }
  }

  const last = frames.at(-1);
  if (
    options.voiceDurationMs !== undefined &&
    typeof last?.endMs === "number" &&
    last.endMs > options.voiceDurationMs + VOICE_SLACK_MS
  ) {
    issues.push({
      severity: "error",
      code: "beyond_voice",
      path: ["frames", frames.length - 1, "endMs"],
      message: `The last frame ends at ${seconds(last.endMs)}, after the voice ends at ${seconds(options.voiceDurationMs)}`,
    });
  }
  return issues;
}

/** Whether a list of issues leaves the storyboard renderable. */
export function hasErrors(issues: readonly StoryboardIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

export class StoryboardValidationError extends Error {
  readonly issues: StoryboardIssue[];

  constructor(issues: StoryboardIssue[]) {
    const errors = issues.filter((issue) => issue.severity === "error");
    super(
      `The storyboard is not renderable: ${errors
        .slice(0, 5)
        .map((issue) => issue.message)
        .join("; ")}${errors.length > 5 ? ` (and ${errors.length - 5} more)` : ""}`,
    );
    this.name = "StoryboardValidationError";
    this.issues = issues;
  }
}

/** Parses and validates a storyboard, throwing `StoryboardValidationError` on any error. */
export function parseStoryboard(
  input: unknown,
  registry: CardRegistry,
  options: ValidateStoryboardOptions = {},
): Storyboard {
  const issues = validateStoryboard(input, registry, options);
  if (hasErrors(issues)) throw new StoryboardValidationError(issues);
  return StoryboardSchema.parse(input);
}
