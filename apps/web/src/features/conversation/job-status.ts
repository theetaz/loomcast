import type { JobStatus, JobSummary } from "@loomcast/contracts";
import type { StatusTone } from "@loomcast/ui/components/StatusPill";
import type { JobActivity } from "./store";

/** Whether the studio agent that would run the job is connected. */
export type StudioAvailability = "online" | "offline" | "unpaired" | "unknown";

export interface JobStatusView {
  /** Short state, for the status line and screen readers. */
  label: string;
  /** What is happening now, or why it stopped. */
  detail?: string;
  tone: StatusTone;
  /** The job is still on its way; the indicator pulses. */
  active: boolean;
  canCancel: boolean;
  canRetry: boolean;
  /** Nothing to show: the reply arrived. */
  hidden: boolean;
}

const ORDER: Record<JobStatus, number> = {
  queued: 0,
  dispatched: 1,
  running: 2,
  succeeded: 3,
  failed: 3,
  cancelled: 3,
};

export function isTerminal(status: JobStatus): boolean {
  return ORDER[status] === 3;
}

/**
 * The later of two snapshots of the same job. The API's answer to a post and
 * the live `job.updated` events race; a snapshot never moves a job backwards.
 */
export function laterJob(current: JobSummary | undefined, next: JobSummary): JobSummary {
  if (!current || current.id !== next.id) return next;
  if (ORDER[next.status] !== ORDER[current.status]) {
    return ORDER[next.status] > ORDER[current.status] ? next : current;
  }
  if (current.cancelRequestedAt && !next.cancelRequestedAt && !isTerminal(next.status)) {
    return current;
  }
  return next;
}

/** Plain-language reasons for the error codes the job registry defines. */
function failureDetail(job: Pick<JobSummary, "error">): string {
  const error = job.error;
  switch (error?.code) {
    case "interrupted":
      return "The studio agent lost its connection while working on this.";
    case "timeout":
      return "The reply took too long and was stopped.";
    case "producer_not_authenticated":
      return error.message || "The producer session on the studio agent is signed out.";
    case "unsupported_job_type":
      return "This studio agent can't answer messages yet. Update it and try again.";
    default:
      return error?.message || "Something went wrong on the studio agent.";
  }
}

/**
 * Maps a job and what surrounds it to the status line: queued, waiting for
 * an offline studio agent, starting, running with its latest tool activity,
 * then done, failed or cancelled.
 */
export function describeJob(
  job: Pick<JobSummary, "status" | "error" | "cancelRequestedAt">,
  context: { studio: StudioAvailability; activity?: JobActivity | null; streaming?: boolean },
): JobStatusView {
  const base = { active: false, canCancel: false, canRetry: false, hidden: false };
  const cancelling = job.cancelRequestedAt !== null && !isTerminal(job.status);
  if (cancelling) {
    return { ...base, label: "Cancelling", tone: "gray", active: true };
  }

  switch (job.status) {
    case "queued":
      if (context.studio === "offline" || context.studio === "unpaired") {
        return {
          ...base,
          label:
            context.studio === "unpaired"
              ? "Waiting for studio agent (none paired)"
              : "Waiting for studio agent (offline)",
          tone: "amber",
          active: true,
          canCancel: true,
        };
      }
      return { ...base, label: "Queued", tone: "gray", active: true, canCancel: true };
    case "dispatched":
      return {
        ...base,
        label: "Starting",
        detail: "sent to the studio agent",
        tone: "blue",
        active: true,
        canCancel: true,
      };
    case "running": {
      const detail =
        context.activity?.summary || (context.streaming ? "Writing the reply" : "Thinking");
      return { ...base, label: "Running", detail, tone: "violet", active: true, canCancel: true };
    }
    case "succeeded":
      return { ...base, label: "Done", tone: "green", hidden: true };
    case "failed":
      return { ...base, label: "Failed", detail: failureDetail(job), tone: "red", canRetry: true };
    case "cancelled":
      return { ...base, label: "Cancelled", tone: "gray", canRetry: true };
    default:
      return { ...base, label: String(job.status), tone: "gray" };
  }
}
