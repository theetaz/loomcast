import {
  competitorTag,
  KbCompetitorReportPayloadSchema,
  KbCompetitorReportResultSchema,
} from "@loomcast/contracts";
import { competitorScans, type Database } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { audit } from "../../../lib/audit";
import type { EventBus } from "../../../lib/bus";
import { failReportingScan, finishScan, reportBody, scanError } from "../../competitors/progress";
import { createKbService, type KbActor } from "../../kb/service";
import type { JobTypeHooks } from "../hooks";
import { createJobsService } from "../service";

/** The tag every competitor report carries, besides `competitor` and the competitor's own tag. */
export const COMPETITOR_REPORT_TAG = "competitor-report";

/**
 * `kb.competitor_report` side effects. Each applies only while the job is still the report job of
 * a scan that is `reporting`, so a cancelled scan never gets a late report:
 * - succeeded: the result is validated again, then written as a `note` entry (the report's
 *   markdown followed by the insights), and the scan becomes `done`, or `partial` when some videos
 *   could not be analysed. A result that fails the schema marks the scan `failed`;
 * - failed or cancelled: the scan becomes `failed` with the job's error.
 */
export function createKbCompetitorReportHooks(deps: { db: Database; bus: EventBus }): JobTypeHooks {
  const { db, bus } = deps;
  const kb = createKbService({ db, bus, jobs: createJobsService({ db, bus }) });

  return {
    async onSucceeded(tx, job, result) {
      const payload = KbCompetitorReportPayloadSchema.safeParse(job.payload);
      if (!payload.success) {
        return;
      }
      const [scan] = await tx
        .select()
        .from(competitorScans)
        .where(eq(competitorScans.id, payload.data.scanId))
        .limit(1)
        .for("update");
      if (scan === undefined || scan.reportJobId !== job.id || scan.status !== "reporting") {
        return;
      }
      const parsed = KbCompetitorReportResultSchema.safeParse(result);
      if (!parsed.success) {
        await finishScan(tx, scan.id, "failed", {
          error: scanError("invalid_result", "The report did not match the expected shape."),
        });
        return;
      }
      const { platform, handle } = payload.data.competitor;
      const date = (job.finishedAt ?? new Date()).toISOString().slice(0, 10);
      const actor: KbActor =
        job.claimedByDevice === null
          ? { kind: "user", id: job.createdBy, userId: job.createdBy, via: "producer" }
          : { kind: "device", id: job.claimedByDevice, userId: job.createdBy, via: "producer" };
      const entry = await kb.createIn(
        tx,
        scan.projectId,
        {
          kind: "note",
          title: `Competitor report: @${handle} (${date})`,
          bodyMd: reportBody(parsed.data.reportMd, parsed.data.insights),
          tags: ["competitor", competitorTag(platform, handle), COMPETITOR_REPORT_TAG],
        },
        actor,
      );
      const status = payload.data.failedVideos > 0 ? "partial" : "done";
      await finishScan(tx, scan.id, status, { reportEntryId: entry.id });
      await audit(tx, {
        actorKind: actor.kind,
        actorId: actor.id,
        action: "competitor.scan.report",
        targetType: "competitor_scan",
        targetId: scan.id,
        data: { projectId: scan.projectId, entryId: entry.id, jobId: job.id, status },
      });
    },

    async onStatusChanged(job) {
      if (job.status !== "failed" && job.status !== "cancelled") {
        return;
      }
      await failReportingScan(
        db,
        job.id,
        job.status === "cancelled"
          ? scanError("cancelled", "The report was cancelled.")
          : scanError(
              job.error?.code ?? "report_failed",
              job.error?.message ?? "The report could not be written.",
            ),
      );
    },
  };
}
