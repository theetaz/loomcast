import { JOB_STATUSES, type JobStatus, TERMINAL_JOB_STATUSES } from "@loomcast/contracts";

/**
 * What can happen to a job:
 * - `dispatch`: the dispatcher claims a queued job for a studio agent.
 * - `accept`: the agent accepted it (or confirmed it again after a reconnect).
 * - `complete` / `fail`: the agent reported the outcome, or the server failed the job.
 * - `requeue`: the job goes back to the queue (accept timeout, reject, lease expiry).
 * - `cancel`: the job ends as cancelled.
 */
export const JOB_ACTIONS = ["dispatch", "accept", "complete", "fail", "requeue", "cancel"] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

const TERMINAL: ReadonlySet<JobStatus> = new Set(TERMINAL_JOB_STATUSES);

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * The status after `action`, or null when the action is not allowed from `status`. Every status
 * change in the job lifecycle goes through this function; terminal statuses never change again.
 */
export function nextStatus(status: JobStatus, action: JobAction): JobStatus | null {
  if (TERMINAL.has(status)) {
    return null;
  }
  switch (action) {
    case "dispatch":
      return status === "queued" ? "dispatched" : null;
    case "accept":
      // Accepting a running job again is how the agent confirms it after a reconnect.
      return status === "dispatched" || status === "running" ? "running" : null;
    case "complete":
      // A job may finish before its accept was seen, for example after a reconnect.
      return status === "dispatched" || status === "running" ? "succeeded" : null;
    case "fail":
      return status === "dispatched" || status === "running" ? "failed" : null;
    case "requeue":
      return status === "dispatched" || status === "running" ? "queued" : null;
    case "cancel":
      return "cancelled";
  }
}

/** The statuses `action` is allowed from: the guard of the matching `UPDATE ... WHERE`. */
export function statusesAllowing(action: JobAction): JobStatus[] {
  return JOB_STATUSES.filter((status) => nextStatus(status, action) !== null);
}
