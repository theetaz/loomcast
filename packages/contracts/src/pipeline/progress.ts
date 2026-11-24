import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { PipelineStateSchema } from "../enums";

/**
 * Production progress reported by a producer outside Loomcast, such as Content Machine on the
 * owner's Mac. It sits beside an item and never changes the item's pipeline state: it shows how
 * the item is being made, step by step, and which skills and tools made each step.
 */

/** The steps every brand's work moves through, in order. A step a format does not need is `skipped`. */
export const PROGRESS_STEPS = [
  "idea",
  "research",
  "script",
  "voice",
  "visuals",
  "render",
  "checks",
  "ready",
  "scheduled",
  "published",
] as const;
export const ProgressStepKeySchema = z.enum(PROGRESS_STEPS);
export type ProgressStepKey = (typeof PROGRESS_STEPS)[number];

export const PROGRESS_STEP_LABELS: Record<ProgressStepKey, string> = {
  idea: "Idea",
  research: "Research",
  script: "Script",
  voice: "Voice",
  visuals: "Visuals",
  render: "Render",
  checks: "Checks",
  ready: "Ready",
  scheduled: "Scheduled",
  published: "Published",
};

export const PROGRESS_STEP_STATUSES = ["pending", "active", "done", "failed", "skipped"] as const;
export const ProgressStepStatusSchema = z.enum(PROGRESS_STEP_STATUSES);
export type ProgressStepStatus = (typeof PROGRESS_STEP_STATUSES)[number];

export const PROGRESS_CHECK_STATUSES = ["pass", "warn", "fail"] as const;
export const ProgressCheckStatusSchema = z.enum(PROGRESS_CHECK_STATUSES);
export type ProgressCheckStatus = (typeof PROGRESS_CHECK_STATUSES)[number];

export const PROGRESS_LIMITS = {
  source: 40,
  path: 300,
  style: 80,
  name: 80,
  note: 500,
  error: 1000,
  checks: 50,
  reportItems: 50,
} as const;

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const ProgressStepSchema = z.object({
  key: ProgressStepKeySchema,
  status: ProgressStepStatusSchema,
  /** The skill that guided the step, such as `unfolded-explainer-reel`. */
  skill: shortText(PROGRESS_LIMITS.name).nullable().default(null),
  /** The command or tool that did the work, such as `cm say`. */
  tool: shortText(PROGRESS_LIMITS.name).nullable().default(null),
  startedAt: TimestampSchema.nullable().default(null),
  finishedAt: TimestampSchema.nullable().default(null),
  note: shortText(PROGRESS_LIMITS.note).nullable().default(null),
  error: shortText(PROGRESS_LIMITS.error).nullable().default(null),
});
export type ProgressStep = z.infer<typeof ProgressStepSchema>;

export const ProgressCheckSchema = z.object({
  name: shortText(PROGRESS_LIMITS.name),
  status: ProgressCheckStatusSchema,
  detail: shortText(PROGRESS_LIMITS.note).nullable().default(null),
});
export type ProgressCheck = z.infer<typeof ProgressCheckSchema>;

/** At most one entry per step, in any order; steps left out count as `pending`. */
export const ProgressStepsSchema = z
  .array(ProgressStepSchema)
  .max(PROGRESS_STEPS.length)
  .refine((steps) => new Set(steps.map((step) => step.key)).size === steps.length, {
    message: "Each step may appear once.",
  });

/** One item's progress as a producer reports it. */
export const ProgressReportSchema = z.object({
  itemId: IdSchema,
  /** Who reports it, such as `content-machine`. */
  source: shortText(PROGRESS_LIMITS.source),
  /** Where the work lives on the producer's machine, relative to its repository. */
  path: shortText(PROGRESS_LIMITS.path),
  /** The video style within the brand, such as `build-ladder`. */
  style: shortText(PROGRESS_LIMITS.style).nullable().default(null),
  steps: ProgressStepsSchema,
  checks: z.array(ProgressCheckSchema).max(PROGRESS_LIMITS.checks).default([]),
  /** A ready asset of the item to show on its card: a poster frame or the finished video. */
  previewAssetId: IdSchema.nullable().default(null),
  /** Counts up with every change on the producer's side; an older report never replaces a newer one. */
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** True when the producer guessed the steps from its files instead of recording them. */
  inferred: z.boolean().default(false),
  reportedAt: TimestampSchema,
});
export type ProgressReport = z.infer<typeof ProgressReportSchema>;
export type ProgressReportInput = z.input<typeof ProgressReportSchema>;

/** Where an item's card sits: the first step still to do, or the last one when all are done. */
export const ProgressHealthSchema = z.enum(["idle", "active", "failed", "done"]);
export type ProgressHealth = z.infer<typeof ProgressHealthSchema>;

/** One item's stored progress, with the item fields its card needs. */
export const ContentProgressSchema = z.object({
  itemId: IdSchema,
  workspaceId: IdSchema,
  title: z.string(),
  itemState: PipelineStateSchema,
  source: z.string(),
  path: z.string(),
  style: z.string().nullable(),
  /** Every step in order, the missing ones filled in as `pending`. */
  steps: z.array(ProgressStepSchema),
  checks: z.array(ProgressCheckSchema),
  previewAssetId: IdSchema.nullable(),
  revision: z.number().int().min(0),
  inferred: z.boolean(),
  stage: ProgressStepKeySchema,
  health: ProgressHealthSchema,
  reportedAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ContentProgress = z.infer<typeof ContentProgressSchema>;

const blankStep = (key: ProgressStepKey): ProgressStep => ({
  key,
  status: "pending",
  skill: null,
  tool: null,
  startedAt: null,
  finishedAt: null,
  note: null,
  error: null,
});

/** Every step in order; steps the report left out are `pending`. */
export function completeSteps(steps: readonly ProgressStep[]): ProgressStep[] {
  const byKey = new Map(steps.map((step) => [step.key, step]));
  return PROGRESS_STEPS.map((key) => byKey.get(key) ?? blankStep(key));
}

const settled = (status: ProgressStepStatus) => status === "done" || status === "skipped";

/**
 * The step an item's card sits under and how it is going. The stage is the first failed or active
 * step, else the first pending one, else the last step. The health is `failed` when any step
 * failed, `active` when one is running, `done` when every step is done or skipped, else `idle`.
 */
export function progressStage(steps: readonly ProgressStep[]): {
  stage: ProgressStepKey;
  health: ProgressHealth;
} {
  const all = completeSteps(steps);
  const failed = all.find((step) => step.status === "failed");
  const active = all.find((step) => step.status === "active");
  const pending = all.find((step) => !settled(step.status));
  const stage = (failed ?? active ?? pending)?.key ?? "published";
  const health: ProgressHealth = failed ? "failed" : active ? "active" : pending ? "idle" : "done";
  return { stage, health };
}
