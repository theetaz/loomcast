import type { JobEvent, JobType, JsonObject } from "@loomcast/contracts";
import type { JobRow } from "@loomcast/db";
import type { Transaction } from "../../lib/db";

/**
 * Per-type side effects of the job lifecycle. Hooks run inside the lifecycle's transaction, so
 * their writes commit or roll back with the job change; they publish bus events with
 * `afterCommit(tx, ...)`.
 */
export interface JobTypeHooks {
  /**
   * A durable event was stored for the first time. Replays never reach the hook: the
   * `(job_id, seq)` unique index turns them into no-ops before it runs.
   */
  onEvent?(tx: Transaction, job: JobRow, event: JobEvent): Promise<void>;
  /** The job succeeded. `result` already passed the registry result schema. */
  onSucceeded?(tx: Transaction, job: JobRow, result: JsonObject): Promise<void>;
}

export type JobHooks = { readonly [T in JobType]?: JobTypeHooks };
