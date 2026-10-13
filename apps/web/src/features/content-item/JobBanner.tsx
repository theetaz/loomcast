import type { ContentItemError, JobSummary } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { CircleAlertIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/RelativeTime";
import { errorMessage } from "@/lib/api";
import { useCancelJob } from "./queries";
import { type JobProgress, jobLabel } from "./use-item-job";

function statusLine(job: JobSummary, activity: JobProgress | null): string {
  if (job.cancelRequestedAt) return "Stopping at the next safe point…";
  if (job.status === "queued") return "Waiting for the studio agent to pick it up.";
  if (job.status === "dispatched") return "The studio agent is starting.";
  // An activity that only repeats the job's own name says nothing new; show how far it is.
  if (activity && activity.summary !== jobLabel(job.type)) return activity.summary;
  if (activity?.progress !== undefined) return `${Math.round(activity.progress * 100)}% done`;
  return "The studio agent is working on it.";
}

/** The job producing this item: what it does, how far it is, and Cancel. */
export function JobBanner({ job, activity }: { job: JobSummary; activity: JobProgress | null }) {
  const cancel = useCancelJob();
  const progress = activity?.progress;
  const label = jobLabel(job.type);

  return (
    <section
      aria-label="Production job"
      className="flex flex-col gap-2.5 rounded-lg bg-status-violet/8 px-3.5 py-3"
    >
      <div className="flex items-start gap-2.5">
        <LoaderCircleIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 animate-spin text-status-violet motion-reduce:animate-none"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="font-medium text-body text-foreground">{label}</p>
          <p role="status" className="text-small text-muted-foreground">
            {statusLine(job, activity)}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={cancel.isPending || job.cancelRequestedAt !== null}
          onClick={() =>
            cancel.mutate(job.id, {
              onError: (error) =>
                toast.error("Couldn't cancel the job", { description: errorMessage(error) }),
            })
          }
        >
          <XIcon aria-hidden="true" />
          {job.cancelRequestedAt ? "Cancelling…" : "Cancel"}
        </Button>
      </div>
      {progress !== undefined ? (
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          className="h-1 overflow-hidden rounded-full bg-status-violet/15"
        >
          <div
            className="h-full origin-left rounded-full bg-status-violet transition-transform duration-200 ease-out motion-reduce:transition-none"
            style={{ transform: `scaleX(${progress})` }}
          />
        </div>
      ) : null}
    </section>
  );
}

/** The last production failure, until the next step succeeds. */
export function LastErrorBanner({ error }: { error: ContentItemError }) {
  return (
    <section
      aria-label="Last production error"
      className="flex items-start gap-2.5 rounded-lg bg-status-red/8 px-3.5 py-3"
    >
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-red" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium text-body text-foreground">
          {jobLabel(error.jobType)} failed <RelativeTime value={error.at} format="relative" />
        </p>
        <p className="break-words text-small text-muted-foreground">
          {error.message || "The studio agent gave no reason."}{" "}
          <span className="font-mono text-mono text-text-4">{error.code}</span>
        </p>
      </div>
    </section>
  );
}
