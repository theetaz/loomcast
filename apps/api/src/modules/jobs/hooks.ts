import type { JobEvent, JobSummary, JobType, JsonObject } from "@loomcast/contracts";
import type { JobRow } from "@loomcast/db";
import type { Transaction } from "../../lib/db";

/**
 * Per-type side effects of the job lifecycle. `onEvent` and `onSucceeded` run inside the
 * lifecycle's transaction, so their writes commit or roll back with the job change; they publish
 * bus events with `afterCommit(tx, ...)`. The registry of every type's hooks is
 * `createJobHooks` in `handlers/index.ts`.
 */
export interface JobTypeHooks {
  /**
   * A durable event was stored for the first time. Replays never reach the hook: the
   * `(job_id, seq)` unique index turns them into no-ops before it runs.
   */
  onEvent?(tx: Transaction, job: JobRow, event: JobEvent): Promise<void>;
  /** The job succeeded. `result` already passed the registry result schema. */
  onSucceeded?(tx: Transaction, job: JobRow, result: JsonObject): Promise<void>;
  /**
   * The job's status (or cancel request) changed, for example to `running`, back to `queued`,
   * `failed` or `cancelled`. Runs after that change committed, from the `job.updated` event
   * (`subscribeJobStatusHooks`), outside any lifecycle transaction, so it must be idempotent and
   * tolerate running after a later change.
   */
  onStatusChanged?(job: JobSummary): Promise<void>;
}

export type JobHooks = { readonly [T in JobType]?: JobTypeHooks };
