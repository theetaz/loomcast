import {
  type JobStatus,
  KbAnalyzeReferencePayloadSchema,
  KbAnalyzeReferenceResultSchema,
  type ReferenceAnalysisStatus,
} from "@loomcast/contracts";
import { type Database, kbEntries, kbReferences } from "@loomcast/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { audit } from "../../../lib/audit";
import type { EventBus } from "../../../lib/bus";
import { afterCommit, type Transaction, transaction } from "../../../lib/db";
import { advanceScansOfJob } from "../../competitors/progress";
import { type EntryRow, entryColumns, toKbEntry } from "../../kb/mappers";
import { referenceSearchText } from "../../kb/references";
import { bumpedUpdatedAt, lockEntry } from "../../kb/service";
import type { JobTypeHooks } from "../hooks";
import { createJobsService } from "../service";
import { isTerminalStatus } from "../transitions";

/**
 * How a job status moves the reference's `analysis_status`, and from which statuses. Success is
 * handled in `onSucceeded`, inside the job's own transaction.
 */
const STATUS_MOVES: Partial<
  Record<JobStatus, { to: ReferenceAnalysisStatus; from: readonly ReferenceAnalysisStatus[] }>
> = {
  running: { to: "running", from: ["queued"] },
  // A retry after a lost studio agent puts the job back in the queue.
  queued: { to: "queued", from: ["running"] },
  failed: { to: "failed", from: ["queued", "running"] },
  cancelled: { to: "failed", from: ["queued", "running"] },
};

/**
 * `kb.analyze_reference` side effects. Every change applies only while the job is still the
 * reference's `analysis_job_id`, so a superseded analysis never overwrites a newer one:
 * - running, re-queued, failed or cancelled: the reference's `analysis_status` follows;
 * - succeeded: the result is validated again, then `analysis`, `analyzed_at` and the entry's
 *   `search_extra` are written and `kb.entry.updated` is published. A result that fails the schema
 *   marks the analysis `failed`. The summary becomes the entry body when the body is empty, and a
 *   transcript the studio agent made from uploaded media is kept when the reference has none, and
 *   the media facts it measured (`media`) are stored on the reference.
 *
 * Once the job has ended (succeeded, failed or cancelled), every competitor scan waiting for it
 * is advanced (`advanceScansOfJob`): the last analysis of a scan queues its report.
 */
export function createKbAnalyzeReferenceHooks(deps: { db: Database; bus: EventBus }): JobTypeHooks {
  const { db, bus } = deps;
  const jobsService = createJobsService({ db, bus });

  function publishUpdated(tx: Transaction, row: EntryRow): void {
    const entry = toKbEntry(row);
    afterCommit(tx, () => bus.publish({ type: "kb.entry.updated", payload: { entry } }));
  }

  async function markFailed(tx: Transaction, entry: EntryRow, jobId: string): Promise<void> {
    await tx
      .update(kbReferences)
      .set({ analysisStatus: "failed" })
      .where(and(eq(kbReferences.entryId, entry.id), eq(kbReferences.analysisJobId, jobId)));
    publishUpdated(tx, entry);
  }

  return {
    async onSucceeded(tx, job, result) {
      const payload = KbAnalyzeReferencePayloadSchema.safeParse(job.payload);
      if (!payload.success) {
        return;
      }
      const entry = await lockEntry(tx, payload.data.entryId);
      if (entry === null) {
        return;
      }
      const [reference] = await tx
        .select()
        .from(kbReferences)
        .where(eq(kbReferences.entryId, entry.id))
        .limit(1)
        .for("update");
      if (reference === undefined || reference.analysisJobId !== job.id) {
        return;
      }
      const parsed = KbAnalyzeReferenceResultSchema.safeParse(result);
      if (!parsed.success) {
        await markFailed(tx, entry, job.id);
        return;
      }
      const { analysis, summaryMd, media } = parsed.data;
      // Media analysis returns the transcript it made; a pasted transcript is never replaced.
      const transcript = reference.transcript ?? parsed.data.transcript ?? null;

      const [updatedReference] = await tx
        .update(kbReferences)
        .set({
          analysis,
          analysisStatus: "done",
          analyzedAt: sql`now()`,
          transcript,
          ...(media === undefined ? {} : { mediaFacts: media }),
        })
        .where(eq(kbReferences.entryId, entry.id))
        .returning();
      const [row] = await tx
        .update(kbEntries)
        .set({
          searchExtra: referenceSearchText({ ...(updatedReference ?? reference), analysis }),
          ...(entry.bodyMd.trim() === "" ? { bodyMd: summaryMd } : {}),
          updatedAt: bumpedUpdatedAt,
        })
        .where(eq(kbEntries.id, entry.id))
        .returning(entryColumns);
      if (row === undefined) {
        return;
      }
      await audit(tx, {
        actorKind: "device",
        actorId: job.claimedByDevice,
        action: "kb.entry.update",
        targetType: "kb_entry",
        targetId: entry.id,
        data: { projectId: entry.projectId, fields: ["analysis"], jobId: job.id },
      });
      publishUpdated(tx, row);
    },

    async onStatusChanged(job) {
      await followStatus(job.id, job.status);
      if (isTerminalStatus(job.status)) {
        await advanceScansOfJob(db, jobsService, job.id);
      }
    },
  };

  /** Moves the analysis status of the reference whose analysis job is `jobId`. */
  async function followStatus(jobId: string, status: JobStatus): Promise<void> {
    const move = STATUS_MOVES[status];
    if (move === undefined) {
      return;
    }
    await transaction(db, async (tx) => {
      const [moved] = await tx
        .update(kbReferences)
        .set({ analysisStatus: move.to })
        .where(
          and(
            eq(kbReferences.analysisJobId, jobId),
            inArray(kbReferences.analysisStatus, [...move.from]),
          ),
        )
        .returning({ entryId: kbReferences.entryId });
      if (moved === undefined) {
        return;
      }
      const [entry] = await tx
        .select(entryColumns)
        .from(kbEntries)
        .where(eq(kbEntries.id, moved.entryId))
        .limit(1);
      if (entry !== undefined && entry.deletedAt === null) {
        publishUpdated(tx, entry);
      }
    });
  }
}
