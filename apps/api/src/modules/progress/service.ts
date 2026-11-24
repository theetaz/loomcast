import {
  type ContentProgress,
  completeSteps,
  type PipelineState,
  type ProgressReport,
  type ProgressReportOutcome,
  progressStage,
} from "@loomcast/contracts";
import {
  assets,
  type ContentProgressRow,
  contentItems,
  contentProgress,
  type Database,
} from "@loomcast/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Executor, transaction } from "../../lib/db";

export interface ProgressServiceDeps {
  db: Database;
  bus: EventBus;
}

export interface ProgressReportResult {
  itemId: string;
  outcome: ProgressReportOutcome;
  /** The revision now stored for the item, or null when it has none. */
  revision: number | null;
}

export interface ProgressService {
  /** Stores reports for items of one workspace; each item's outcome, in the order given. */
  report(workspaceId: string, reports: readonly ProgressReport[]): Promise<ProgressReportResult[]>;
  /** Every item of the workspace with progress, most recently updated first. */
  list(workspaceId: string): Promise<ContentProgress[]>;
  /** One item's progress, or null when none was reported. */
  get(itemId: string): Promise<ContentProgress | null>;
}

interface ItemFields {
  title: string;
  state: PipelineState;
}

export function toContentProgress(row: ContentProgressRow, item: ItemFields): ContentProgress {
  const steps = completeSteps(row.steps);
  const { stage, health } = progressStage(steps);
  return {
    itemId: row.itemId,
    workspaceId: row.workspaceId,
    title: item.title,
    itemState: item.state,
    source: row.source,
    path: row.path,
    style: row.style,
    steps,
    checks: row.checks,
    previewAssetId: row.previewAssetId,
    revision: row.revision,
    inferred: row.inferred,
    stage,
    health,
    reportedAt: row.reportedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The fields a report sets, for storing and for comparing with what is stored. */
function fieldsOf(report: ProgressReport) {
  return {
    source: report.source,
    path: report.path,
    style: report.style,
    steps: report.steps,
    checks: report.checks,
    previewAssetId: report.previewAssetId,
    revision: report.revision,
    inferred: report.inferred,
    reportedAt: new Date(report.reportedAt),
  };
}

function sameContent(row: ContentProgressRow, report: ProgressReport): boolean {
  const stored = {
    source: row.source,
    path: row.path,
    style: row.style,
    steps: completeSteps(row.steps),
    checks: row.checks,
    previewAssetId: row.previewAssetId,
    inferred: row.inferred,
  };
  const given = {
    source: report.source,
    path: report.path,
    style: report.style,
    steps: completeSteps(report.steps),
    checks: report.checks,
    previewAssetId: report.previewAssetId,
    inferred: report.inferred,
  };
  return canonical(stored) === canonical(given);
}

/** JSON with object keys sorted, because Postgres `jsonb` does not keep the order they were written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  );
}

async function readJoined(executor: Executor, where: ReturnType<typeof eq>) {
  return executor
    .select({ row: contentProgress, title: contentItems.title, state: contentItems.state })
    .from(contentProgress)
    .innerJoin(contentItems, eq(contentItems.id, contentProgress.itemId))
    .where(where)
    .orderBy(desc(contentProgress.updatedAt), desc(contentProgress.itemId));
}

export function createProgressService(deps: ProgressServiceDeps): ProgressService {
  const { db, bus } = deps;

  return {
    async report(workspaceId, reports) {
      const ids = [...new Set(reports.map((report) => report.itemId))];
      const previewIds = [...new Set(reports.flatMap((report) => report.previewAssetId ?? []))];
      return transaction(db, async (tx) => {
        const items = new Map(
          (
            await tx
              .select({ id: contentItems.id, title: contentItems.title, state: contentItems.state })
              .from(contentItems)
              .where(and(eq(contentItems.workspaceId, workspaceId), inArray(contentItems.id, ids)))
          ).map((item) => [item.id, item]),
        );
        const stored = new Map(
          (
            await tx
              .select()
              .from(contentProgress)
              .where(inArray(contentProgress.itemId, ids))
              .for("update")
          ).map((row) => [row.itemId, row]),
        );
        const previews = new Map(
          previewIds.length === 0
            ? []
            : (
                await tx
                  .select({ id: assets.id, itemId: assets.itemId, status: assets.status })
                  .from(assets)
                  .where(inArray(assets.id, previewIds))
              ).map((asset) => [asset.id, asset]),
        );

        const results: ProgressReportResult[] = [];
        for (const report of reports) {
          const item = items.get(report.itemId);
          const current = stored.get(report.itemId);
          if (item === undefined) {
            results.push({ itemId: report.itemId, outcome: "not_found", revision: null });
            continue;
          }
          if (report.previewAssetId !== null) {
            const preview = previews.get(report.previewAssetId);
            if (preview?.itemId !== item.id || preview.status !== "ready") {
              results.push({
                itemId: item.id,
                outcome: "invalid_preview",
                revision: current?.revision ?? null,
              });
              continue;
            }
          }
          if (current !== undefined && report.revision <= current.revision) {
            const outcome = sameContent(current, report) ? "unchanged" : "stale";
            results.push({ itemId: item.id, outcome, revision: current.revision });
            continue;
          }
          const values = fieldsOf(report);
          const [row] = await tx
            .insert(contentProgress)
            .values({ itemId: item.id, workspaceId, ...values })
            .onConflictDoUpdate({ target: contentProgress.itemId, set: values })
            .returning();
          if (row === undefined) {
            throw new Error("progress upsert returned no row");
          }
          stored.set(item.id, row);
          const progress = toContentProgress(row, item);
          afterCommit(tx, () =>
            bus.publish({ type: "content.progress.updated", payload: { progress } }),
          );
          results.push({ itemId: item.id, outcome: "stored", revision: row.revision });
        }
        return results;
      });
    },

    async list(workspaceId) {
      const rows = await readJoined(db, eq(contentProgress.workspaceId, workspaceId));
      return rows.map(({ row, title, state }) => toContentProgress(row, { title, state }));
    },

    async get(itemId) {
      const [found] = await readJoined(db, eq(contentProgress.itemId, itemId));
      return found === undefined
        ? null
        : toContentProgress(found.row, { title: found.title, state: found.state });
    },
  };
}
