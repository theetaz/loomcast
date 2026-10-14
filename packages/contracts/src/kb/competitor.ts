import { z } from "zod";
import { TimestampSchema } from "../common";

/**
 * Caps of a competitor report. The report is written by a producer session from untrusted
 * captions and transcripts, so every string and list is bounded.
 */
export const COMPETITOR_REPORT_LIMITS = {
  reportMd: 20_000,
  positioning: 2_000,
  item: 500,
  maxItems: 12,
  lengthAndPacing: 2_000,
  postingCadence: 1_000,
  caption: 2_200,
} as const;

const limits = COMPETITOR_REPORT_LIMITS;
const text = (max: number) => z.string().trim().min(1).max(max);
const list = z.array(text(limits.item)).max(limits.maxItems);

/** Public numbers of one competitor video, as the platform reported them when it was picked. */
export const CompetitorVideoMetricsSchema = z.object({
  views: z.number().int().min(0).nullable(),
  likes: z.number().int().min(0).nullable(),
  comments: z.number().int().min(0).nullable(),
  postedAt: TimestampSchema.nullable(),
});
export type CompetitorVideoMetrics = z.infer<typeof CompetitorVideoMetricsSchema>;

/**
 * What a `kb.competitor_report` job concludes about one competitor from its top videos. Every list
 * item is one short sentence; `opportunities` are gaps the project could fill.
 */
export const CompetitorInsightsSchema = z.object({
  /** Who the competitor speaks to and how it positions itself. */
  positioning: text(limits.positioning),
  topics: list,
  hookPatterns: list,
  formats: list,
  /** How video length and pacing relate to the numbers. */
  lengthAndPacing: text(limits.lengthAndPacing),
  postingCadence: text(limits.postingCadence).optional(),
  whatWorks: list.min(1),
  opportunities: list,
  recommendations: list.min(1),
});
export type CompetitorInsights = z.infer<typeof CompetitorInsightsSchema>;
