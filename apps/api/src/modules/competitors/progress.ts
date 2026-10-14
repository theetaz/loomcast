import {
  COMPETITOR_REPORT_LIMITS,
  type CompetitorInsights,
  type CompetitorScanError,
  type CompetitorScanStatus,
  type JobStatus,
  KbCompetitorReportPayloadSchema,
  MAX_ANALYSIS_SUMMARY_LENGTH,
  MAX_KB_BODY_LENGTH,
} from "@loomcast/contracts";
import {
  competitorScans,
  competitorScanVideos,
  competitors,
  type Database,
  jobs,
  kbEntries,
  kbReferences,
} from "@loomcast/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import { type Transaction, transaction } from "../../lib/db";
import type { JobsService } from "../jobs/service";

// How a scan moves after it started: `analyzing` until every picked video's analysis has ended,
// then `reporting` while `kb.competitor_report` writes the report, then `done`, `partial` or
// `failed`. Every move locks the scan row and re-reads its status first, so the hooks of jobs
// that end at the same time (or run twice) move a scan once.

/** Job statuses in which an analysis or a report is still on its way. */
export const ACTIVE_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "queued",
  "dispatched",
  "running",
]);

export function scanError(code: string, message: string): CompetitorScanError {
  return { code: code.slice(0, 64), message: message.slice(0, 2_000) };
}

/** The idempotency key of a scan's analysis of one reference. */
export function scanAnalysisKey(scanId: string, entryId: string): string {
  return `competitor:${scanId}:${entryId}`;
}

/** The idempotency key of a scan's report. */
export function scanReportKey(scanId: string): string {
  return `competitor-report:${scanId}`;
}

/** Ends a scan with `status`, recording `error` when there is one. */
export async function finishScan(
  tx: Transaction,
  scanId: string,
  status: Extract<CompetitorScanStatus, "done" | "partial" | "failed" | "cancelled">,
  values: { error?: CompetitorScanError | null; reportEntryId?: string } = {},
): Promise<void> {
  await tx
    .update(competitorScans)
    .set({
      status,
      finishedAt: sql`now()`,
      ...(values.error === undefined ? {} : { error: values.error }),
      ...(values.reportEntryId === undefined ? {} : { reportEntryId: values.reportEntryId }),
    })
    .where(eq(competitorScans.id, scanId));
}

/**
 * Moves an `analyzing` scan on once none of its videos' analyses is still queued or running:
 * - at least one video's reference has an analysis (`done`): queues `kb.competitor_report` with
 *   the analysed videos, most popular first, and marks the scan `reporting`;
 * - none has: marks the scan `failed`.
 *
 * A video counts as analysed when its reference's analysis is `done`; as pending while the
 * analysis job the scan waits for is still active; as failed otherwise. Does nothing for a scan in
 * any other status, so it is safe to call again or concurrently.
 */
export async function advanceScan(
  tx: Transaction,
  jobsService: JobsService,
  scanId: string,
): Promise<void> {
  const [scan] = await tx
    .select()
    .from(competitorScans)
    .where(eq(competitorScans.id, scanId))
    .limit(1)
    .for("update");
  if (scan === undefined || scan.status !== "analyzing") {
    return;
  }
  const [competitor] = await tx
    .select()
    .from(competitors)
    .where(eq(competitors.id, scan.competitorId))
    .limit(1);
  if (competitor === undefined) {
    return;
  }
  const videos = await tx
    .select({
      rank: competitorScanVideos.rank,
      entryId: competitorScanVideos.entryId,
      url: competitorScanVideos.url,
      caption: competitorScanVideos.caption,
      views: competitorScanVideos.views,
      likes: competitorScanVideos.likes,
      comments: competitorScanVideos.comments,
      postedAt: competitorScanVideos.postedAt,
      jobStatus: jobs.status,
      jobCreatedBy: jobs.createdBy,
      referenceUrl: kbReferences.url,
      analysisStatus: kbReferences.analysisStatus,
      analysis: kbReferences.analysis,
      mediaFacts: kbReferences.mediaFacts,
      bodyMd: kbEntries.bodyMd,
    })
    .from(competitorScanVideos)
    .innerJoin(kbEntries, eq(kbEntries.id, competitorScanVideos.entryId))
    .leftJoin(kbReferences, eq(kbReferences.entryId, competitorScanVideos.entryId))
    .leftJoin(jobs, eq(jobs.id, competitorScanVideos.analysisJobId))
    .where(eq(competitorScanVideos.scanId, scan.id))
    .orderBy(asc(competitorScanVideos.rank));

  const analysed: typeof videos = [];
  let failed = 0;
  for (const video of videos) {
    if (video.analysisStatus === "done" && video.analysis !== null) {
      analysed.push(video);
    } else if (video.jobStatus !== null && ACTIVE_JOB_STATUSES.has(video.jobStatus)) {
      return;
    } else {
      failed += 1;
    }
  }
  if (analysed.length === 0) {
    await finishScan(tx, scan.id, "failed", {
      error: scanError("no_videos_analysed", "None of the picked videos could be analysed."),
    });
    return;
  }

  const payload = KbCompetitorReportPayloadSchema.safeParse({
    projectId: scan.projectId,
    scanId: scan.id,
    competitor: {
      platform: competitor.platform,
      handle: competitor.handle,
      displayName: competitor.displayName?.slice(0, 300) ?? null,
      followersCount: competitor.followersCount,
      mediaCount: competitor.mediaCount,
    },
    videos: analysed.map((video) => ({
      rank: video.rank,
      entryId: video.entryId,
      url: video.referenceUrl ?? video.url,
      caption: video.caption?.slice(0, COMPETITOR_REPORT_LIMITS.caption) ?? null,
      metrics: {
        views: video.views,
        likes: video.likes,
        comments: video.comments,
        postedAt: video.postedAt?.toISOString() ?? null,
      },
      durationMs: video.mediaFacts?.durationMs ?? null,
      analysis: video.analysis,
      summaryMd: video.bodyMd.slice(0, MAX_ANALYSIS_SUMMARY_LENGTH),
    })),
    failedVideos: failed,
  });
  const createdBy =
    scan.createdBy ??
    competitor.createdBy ??
    analysed.find((video) => video.jobCreatedBy !== null)?.jobCreatedBy ??
    null;
  if (!payload.success || createdBy === null) {
    await finishScan(tx, scan.id, "failed", {
      error: scanError("report_not_queued", "The report could not be queued from the analyses."),
    });
    return;
  }
  const { job } = await jobsService.enqueue(tx, {
    type: "kb.competitor_report",
    payload: payload.data,
    projectId: scan.projectId,
    conversationId: null,
    idempotencyKey: scanReportKey(scan.id),
    createdBy,
  });
  await tx
    .update(competitorScans)
    .set({ status: "reporting", reportJobId: job.id })
    .where(eq(competitorScans.id, scan.id));
}

/**
 * Advances every `analyzing` scan that waits for the analysis job `jobId`, each in its own
 * transaction. Called once the job ended (succeeded, failed or cancelled).
 */
export async function advanceScansOfJob(
  db: Database,
  jobsService: JobsService,
  jobId: string,
): Promise<void> {
  const rows = await db
    .selectDistinct({ scanId: competitorScanVideos.scanId })
    .from(competitorScanVideos)
    .innerJoin(competitorScans, eq(competitorScans.id, competitorScanVideos.scanId))
    .where(
      and(eq(competitorScanVideos.analysisJobId, jobId), eq(competitorScans.status, "analyzing")),
    );
  for (const { scanId } of rows) {
    await transaction(db, (tx) => advanceScan(tx, jobsService, scanId));
  }
}

/**
 * Marks the scan whose report job `jobId` failed or was cancelled as `failed`, unless the scan
 * already left `reporting`.
 */
export async function failReportingScan(
  db: Database,
  jobId: string,
  error: CompetitorScanError,
): Promise<void> {
  await transaction(db, async (tx) => {
    const [scan] = await tx
      .select({ id: competitorScans.id, status: competitorScans.status })
      .from(competitorScans)
      .where(eq(competitorScans.reportJobId, jobId))
      .limit(1)
      .for("update");
    if (scan === undefined || scan.status !== "reporting") {
      return;
    }
    await finishScan(tx, scan.id, "failed", { error });
    await audit(tx, {
      actorKind: "system",
      action: "competitor.scan.fail",
      targetType: "competitor_scan",
      targetId: scan.id,
      data: { jobId, code: error.code },
    });
  });
}

function bulletList(heading: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : [`### ${heading}`, "", ...items.map((item) => `- ${item}`), ""];
}

/** The structured insights of a report as markdown, after the report's own text. */
export function insightsMarkdown(insights: CompetitorInsights): string {
  const lines = [
    "## Insights",
    "",
    `**Positioning.** ${insights.positioning}`,
    "",
    ...bulletList("Topics", insights.topics),
    ...bulletList("Hook patterns", insights.hookPatterns),
    ...bulletList("Formats", insights.formats),
    `**Length and pacing.** ${insights.lengthAndPacing}`,
    "",
    ...(insights.postingCadence === undefined
      ? []
      : [`**Posting cadence.** ${insights.postingCadence}`, ""]),
    ...bulletList("What works", insights.whatWorks),
    ...bulletList("Opportunities", insights.opportunities),
    ...bulletList("Recommendations", insights.recommendations),
  ];
  return lines.join("\n").trimEnd();
}

/** The body of a report note: the report's markdown, then its insights. */
export function reportBody(reportMd: string, insights: CompetitorInsights): string {
  return `${reportMd.trim()}\n\n${insightsMarkdown(insights)}`.slice(0, MAX_KB_BODY_LENGTH);
}
