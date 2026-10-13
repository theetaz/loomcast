import { OPEN_POST_STATUSES } from "@loomcast/contracts";
import { scheduledPosts } from "@loomcast/db";
import { and, eq, inArray } from "drizzle-orm";
import type { ModuleDeps } from "../../deps";
import { HttpError } from "../../lib/errors";
import { contentServiceFor } from "../content";
import { productionServiceFor } from "../production";

/** What `cadence.produce` did with an item. */
export type ProduceOutcome =
  /** Autopilot runs (or a production job was already running). */
  | { kind: "started"; jobId: string | null }
  /** The item is gone or archived. */
  | { kind: "gone" }
  /** The item no longer holds a slot: its posts were cancelled or it was detached. */
  | { kind: "no_slot" }
  /** Production refused for a reason a retry cannot fix, such as a format without a voice. */
  | { kind: "failed"; code: string; message: string };

/**
 * Starts production of a planned item up to review (`produce(itemId, {through: "review"})`), as
 * the system. Items that were archived or gave up their slot are skipped. Refusals of the
 * production service (4xx) come back as `failed`; anything else throws, so the task retries.
 */
export async function produceForSlot(deps: ModuleDeps, itemId: string): Promise<ProduceOutcome> {
  const item = await contentServiceFor(deps).getItem(itemId);
  if (item === null || item.state === "archived") {
    return { kind: "gone" };
  }
  const [open] = await deps.db
    .select({ id: scheduledPosts.id })
    .from(scheduledPosts)
    .where(
      and(
        eq(scheduledPosts.itemId, itemId),
        inArray(scheduledPosts.status, [...OPEN_POST_STATUSES]),
      ),
    )
    .limit(1);
  if (open === undefined) {
    return { kind: "no_slot" };
  }
  try {
    const { job } = await productionServiceFor(deps).produce(itemId, { through: "review" });
    return { kind: "started", jobId: job?.id ?? null };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return { kind: "gone" };
    }
    if (error instanceof HttpError && error.status < 500) {
      return { kind: "failed", code: error.code, message: error.message };
    }
    throw error;
  }
}
