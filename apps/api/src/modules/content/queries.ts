import { IdSchema, JOB_TYPES, type JobType } from "@loomcast/contracts";
import {
  assets,
  type ContentItemRow,
  type ContentVersionRow,
  contentItems,
  contentVersions,
  type JobRow,
  jobs,
} from "@loomcast/db";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Executor, Transaction } from "../../lib/db";
import {
  type ItemRow,
  itemColumns,
  type VersionSummaryRow,
  versionSummaryColumns,
} from "./mappers";

/** Job types that produce versions of an item; at most one of them runs per item at a time. */
export const PRODUCTION_JOB_TYPES = JOB_TYPES.filter((type) =>
  type.startsWith("content."),
) as readonly JobType[];

const ACTIVE_JOB_STATUSES = ["queued", "dispatched", "running"] as const;

/** `content_items` with the derived columns of `itemColumns`. */
export function selectItems(executor: Executor) {
  return selectItemsWith(executor, {});
}

/** `selectItems` with extra columns, such as a keyset cursor. */
export function selectItemsWith<E extends Record<string, SQL.Aliased | SQL>>(
  executor: Executor,
  extra: E,
) {
  return executor
    .select({ ...itemColumns, ...extra })
    .from(contentItems)
    .innerJoin(contentVersions, eq(contentVersions.id, contentItems.currentVersionId))
    .leftJoin(assets, eq(assets.id, contentVersions.renderAssetId));
}

/** An item with its derived columns, or null. */
export async function findItem(executor: Executor, id: string): Promise<ItemRow | null> {
  if (!IdSchema.safeParse(id).success) {
    return null;
  }
  const [row] = await selectItems(executor).where(eq(contentItems.id, id)).limit(1);
  return row ?? null;
}

/**
 * The item row locked `FOR UPDATE`, or null. Every write that reads the state or the current
 * version first takes this lock, so writers of one item queue up.
 */
export async function lockItem(tx: Transaction, id: string): Promise<ContentItemRow | null> {
  if (!IdSchema.safeParse(id).success) {
    return null;
  }
  const [row] = await tx
    .select()
    .from(contentItems)
    .where(eq(contentItems.id, id))
    .limit(1)
    .for("update");
  return row ?? null;
}

/** A version of the item, or null when there is none with that id on that item. */
export async function findVersion(
  executor: Executor,
  itemId: string,
  versionId: string,
): Promise<ContentVersionRow | null> {
  if (!IdSchema.safeParse(versionId).success) {
    return null;
  }
  const [row] = await executor
    .select()
    .from(contentVersions)
    .where(and(eq(contentVersions.id, versionId), eq(contentVersions.itemId, itemId)))
    .limit(1);
  return row ?? null;
}

/** The version written for a job's result, if any (`content_versions.job_id` is unique). */
export async function findVersionOfJob(
  executor: Executor,
  jobId: string,
): Promise<ContentVersionRow | null> {
  const [row] = await executor
    .select()
    .from(contentVersions)
    .where(eq(contentVersions.jobId, jobId))
    .limit(1);
  return row ?? null;
}

/** Every version of an item without its artifacts, newest first. */
export function versionSummaries(executor: Executor, itemId: string): Promise<VersionSummaryRow[]> {
  return executor
    .select(versionSummaryColumns)
    .from(contentVersions)
    .where(eq(contentVersions.itemId, itemId))
    .orderBy(desc(contentVersions.versionNo));
}

/**
 * The production job queued or running for an item, newest first. Jobs carry the item in their
 * payload (`payload->>'itemId'`); there is no item column.
 */
export async function activeProductionJob(
  executor: Executor,
  item: Pick<ContentItemRow, "id" | "workspaceId">,
): Promise<JobRow | null> {
  const [row] = await executor
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.workspaceId, item.workspaceId),
        inArray(jobs.type, [...PRODUCTION_JOB_TYPES]),
        inArray(jobs.status, [...ACTIVE_JOB_STATUSES]),
        sql`${jobs.payload}->>'itemId' = ${item.id}`,
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return row ?? null;
}
