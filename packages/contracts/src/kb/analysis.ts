import { z } from "zod";

/**
 * Caps of `ReferenceAnalysis`. The analysis is written by a producer session from untrusted
 * transcript text, so every string and list is bounded.
 */
export const REFERENCE_ANALYSIS_LIMITS = {
  hookText: 500,
  hookType: 64,
  sectionLabel: 80,
  sectionSummary: 1_000,
  maxSections: 30,
  pacingNotes: 2_000,
  technique: 120,
  evidence: 1_000,
  maxRetention: 20,
  visualStyle: 2_000,
  cta: 500,
  takeaway: 500,
  maxTakeaways: 10,
  applicability: 2_000,
  /** Longest video position, in milliseconds (one hour). */
  maxPositionMs: 60 * 60_000,
} as const;

const limits = REFERENCE_ANALYSIS_LIMITS;

const text = (max: number) => z.string().trim().min(1).max(max);
const positionMs = z.number().int().min(0).max(limits.maxPositionMs);

/** The opening line or moment that makes a viewer stay. */
export const ReferenceHookSchema = z.object({
  text: text(limits.hookText),
  /** A short label such as `question`, `bold-claim`, `pattern-interrupt` or `demo-first`. */
  type: text(limits.hookType),
  timeToHookMs: positionMs.optional(),
});
export type ReferenceHook = z.infer<typeof ReferenceHookSchema>;

/** One beat of the video's structure. */
export const ReferenceSectionSchema = z
  .object({
    label: text(limits.sectionLabel),
    startMs: positionMs.optional(),
    endMs: positionMs.optional(),
    summary: text(limits.sectionSummary),
  })
  .refine(
    (section) =>
      section.startMs === undefined ||
      section.endMs === undefined ||
      section.endMs >= section.startMs,
    { message: "endMs must not be before startMs", path: ["endMs"] },
  );
export type ReferenceSection = z.infer<typeof ReferenceSectionSchema>;

export const ReferencePacingSchema = z.object({
  wordsPerMinute: z.number().min(0).max(1_000).optional(),
  cutsPerMinute: z.number().min(0).max(600).optional(),
  notes: z.string().trim().max(limits.pacingNotes),
});
export type ReferencePacing = z.infer<typeof ReferencePacingSchema>;

/** A technique that keeps viewers watching, with what in the video shows it. */
export const ReferenceRetentionSchema = z.object({
  technique: text(limits.technique),
  evidence: text(limits.evidence),
});
export type ReferenceRetention = z.infer<typeof ReferenceRetentionSchema>;

/**
 * Structured analysis of a reference video, produced by the `kb.analyze_reference` job and stored
 * on the reference. Unknown fields are dropped.
 */
export const ReferenceAnalysisSchema = z.object({
  hook: ReferenceHookSchema,
  structure: z.array(ReferenceSectionSchema).max(limits.maxSections),
  pacing: ReferencePacingSchema,
  retention: z.array(ReferenceRetentionSchema).max(limits.maxRetention),
  visualStyle: text(limits.visualStyle).optional(),
  cta: text(limits.cta).optional(),
  takeaways: z.array(text(limits.takeaway)).min(1).max(limits.maxTakeaways),
  /** How the takeaways apply to the workspace the reference was saved in. */
  applicability: text(limits.applicability),
});
export type ReferenceAnalysis = z.infer<typeof ReferenceAnalysisSchema>;

/** Longest markdown summary a `kb.analyze_reference` job returns next to the analysis. */
export const MAX_ANALYSIS_SUMMARY_LENGTH = 4_000;
