import type {
  JobStatus,
  JobSummary,
  KbReferenceDetail,
  ReferenceAnalysisStatus,
} from "@loomcast/contracts";

/** How a reference's analysis is shown: the pill, the button and why it may be unavailable. */
export interface AnalysisState {
  /** The job status the pill shows; null before the first analysis. */
  status: JobStatus | null;
  /** The pill's text. */
  label: string;
  /** A job is queued or running. */
  busy: boolean;
  /** "Analyze" the first time, "Re-analyze" once an analysis exists or a run finished. */
  action: "Analyze" | "Re-analyze";
  canAnalyze: boolean;
  /** Why the button is unavailable, or what went wrong. */
  hint: string | null;
}

const REFERENCE_TO_JOB: Record<Exclude<ReferenceAnalysisStatus, "none">, JobStatus> = {
  queued: "queued",
  running: "running",
  done: "succeeded",
  failed: "failed",
};

const PROGRESS: Record<JobStatus, number> = {
  queued: 0,
  dispatched: 1,
  running: 2,
  succeeded: 3,
  failed: 3,
  cancelled: 3,
};

const LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  dispatched: "Starting",
  running: "Analyzing",
  succeeded: "Analyzed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * Combines the status stored on the reference with the latest `job.updated` snapshot of its
 * analysis job. Whichever is further along wins, since live job events usually arrive before the
 * reference is updated; when both have finished, the job's own result is used.
 */
export function analysisState(
  reference: KbReferenceDetail,
  job: JobSummary | undefined,
): AnalysisState {
  const stored =
    reference.analysisStatus === "none" ? null : REFERENCE_TO_JOB[reference.analysisStatus];
  const live = job && job.id === reference.analysisJobId ? job.status : null;

  let status: JobStatus | null = stored;
  if (live !== null && (status === null || PROGRESS[live] >= PROGRESS[status])) status = live;

  const busy = status === "queued" || status === "dispatched" || status === "running";
  const hasTranscript = (reference.transcript ?? "").trim().length > 0;
  // Uploaded media is analysed when there is no transcript.
  const hasMedia = Boolean(reference.mediaAssetId);
  const finished = status === "succeeded" || status === "failed" || status === "cancelled";

  let hint: string | null = null;
  if (!hasTranscript && !hasMedia) {
    hint = "Add a transcript or upload the media to analyze this reference.";
  } else if (status === "failed") {
    hint =
      (live === "failed" ? job?.error?.message : undefined) ||
      "The analysis failed. Try again, or check the studio agent.";
  } else if (status === "queued") hint = "Waiting for a studio agent to pick it up.";

  return {
    status,
    label: status === null ? "Not analyzed" : LABELS[status],
    busy,
    action: reference.analysis || finished ? "Re-analyze" : "Analyze",
    canAnalyze: (hasTranscript || hasMedia) && !busy,
    hint,
  };
}
