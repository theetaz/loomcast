import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import {
  CompetitorPlatformSchema,
  CompetitorScanSourceSchema,
  CompetitorScanStatusSchema,
  ReferenceAnalysisStatusSchema,
} from "../enums";
import { COMPETITOR_REPORT_LIMITS, CompetitorVideoMetricsSchema } from "../kb/competitor";
import { REFERENCE_URL_MAX_LENGTH } from "../util/reference-url";

// Competitor research: a project follows competitors' profiles, and a scan picks their most
// popular videos, analyses each one on the studio agent and writes a report to the knowledge base.
// Every analysed video is an ordinary `reference` entry; the report is a `note` entry.

/** Most videos one scan analyses. */
export const COMPETITOR_SCAN_MAX_VIDEOS = 20;
/** Videos a scan analyses when the request leaves `topN` out. */
export const COMPETITOR_SCAN_DEFAULT_VIDEOS = 10;
/** Most recent posts the official API is asked for when ranking by views. */
export const COMPETITOR_DISCOVERY_MAX_POSTS = 200;
/** Most competitors one project follows. */
export const COMPETITORS_PER_PROJECT_MAX = 50;
export const COMPETITOR_NOTES_MAX_LENGTH = 2_000;

/** What a scan found out about the competitor's account, when the official API answered. */
export const CompetitorAccountSchema = z.object({
  displayName: z.string().max(300).nullable(),
  followersCount: z.number().int().min(0).nullable(),
  mediaCount: z.number().int().min(0).nullable(),
});
export type CompetitorAccount = z.infer<typeof CompetitorAccountSchema>;

export const CompetitorScanSummarySchema = z.object({
  id: IdSchema,
  status: CompetitorScanStatusSchema,
  source: CompetitorScanSourceSchema,
  videoCount: z.number().int().min(0),
  createdAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});
export type CompetitorScanSummary = z.infer<typeof CompetitorScanSummarySchema>;

export const CompetitorSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  platform: CompetitorPlatformSchema,
  handle: z.string(),
  profileUrl: z.string(),
  notes: z.string().nullable(),
  account: CompetitorAccountSchema,
  /** The most recent scan, if any. */
  latestScan: CompetitorScanSummarySchema.nullable(),
  /** The knowledge-base note of the most recent finished report, if any. */
  latestReportEntryId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Competitor = z.infer<typeof CompetitorSchema>;

/** One picked video of a scan, with the reference entry its analysis lives on. */
export const CompetitorScanVideoSchema = z.object({
  /** 1 is the most popular video of the scan. */
  rank: z.number().int().min(1),
  entryId: IdSchema,
  url: z.string(),
  caption: z.string().nullable(),
  metrics: CompetitorVideoMetricsSchema,
  analysisStatus: ReferenceAnalysisStatusSchema,
});
export type CompetitorScanVideo = z.infer<typeof CompetitorScanVideoSchema>;

/** What went wrong with a scan, in words for the user. */
export const CompetitorScanErrorSchema = z.object({
  code: z.string().max(64),
  message: z.string().max(2_000),
});
export type CompetitorScanError = z.infer<typeof CompetitorScanErrorSchema>;

export const CompetitorScanSchema = CompetitorScanSummarySchema.extend({
  competitorId: IdSchema,
  projectId: IdSchema,
  topN: z.number().int().min(1).max(COMPETITOR_SCAN_MAX_VIDEOS),
  videos: z.array(CompetitorScanVideoSchema).max(COMPETITOR_SCAN_MAX_VIDEOS),
  reportEntryId: IdSchema.nullable(),
  error: CompetitorScanErrorSchema.nullable(),
  createdBy: IdSchema.nullable(),
});
export type CompetitorScan = z.infer<typeof CompetitorScanSchema>;

/** `url` is a profile link, or `@handle` for Instagram (`parseCompetitorUrl`). */
export const CreateCompetitorRequestSchema = z.object({
  url: z.string().trim().min(1).max(REFERENCE_URL_MAX_LENGTH),
  notes: z.string().trim().max(COMPETITOR_NOTES_MAX_LENGTH).optional(),
});
export type CreateCompetitorRequest = z.infer<typeof CreateCompetitorRequestSchema>;

export const UpdateCompetitorRequestSchema = z.object({
  notes: z.string().trim().max(COMPETITOR_NOTES_MAX_LENGTH).nullable(),
});
export type UpdateCompetitorRequest = z.infer<typeof UpdateCompetitorRequestSchema>;

/**
 * Starts a scan.
 * - Without `links`, an Instagram competitor is ranked through the official API: the most viewed
 *   Reels of its last `COMPETITOR_DISCOVERY_MAX_POSTS` posts, at most `topN`. That needs an
 *   active Instagram channel; `channelId` picks one, otherwise the first active one is used.
 * - With `links`, exactly those videos are analysed (public video links of the competitor's
 *   platform, `isPublicVideoUrl`). Facebook and Threads competitors always need links.
 *
 * `409 scan_in_progress` while another scan of the competitor is active; `422 links_required`,
 * `422 no_instagram_channel` and `422 not_professional_account` (the account is not a business or
 * creator account, so it needs links) explain why a scan cannot start.
 */
export const CreateCompetitorScanRequestSchema = z.object({
  topN: z
    .number()
    .int()
    .min(1)
    .max(COMPETITOR_SCAN_MAX_VIDEOS)
    .default(COMPETITOR_SCAN_DEFAULT_VIDEOS),
  links: z
    .array(z.string().trim().min(1).max(REFERENCE_URL_MAX_LENGTH))
    .min(1)
    .max(COMPETITOR_SCAN_MAX_VIDEOS)
    .optional(),
  channelId: IdSchema.optional(),
});
export type CreateCompetitorScanRequest = z.input<typeof CreateCompetitorScanRequestSchema>;

/** Longest caption kept per video. */
export const COMPETITOR_CAPTION_MAX_LENGTH = COMPETITOR_REPORT_LIMITS.caption;
