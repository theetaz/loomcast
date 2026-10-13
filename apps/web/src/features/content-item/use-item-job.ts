import type { ContentItemDetail, JobSummary, JobType } from "@loomcast/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { isTerminal } from "@/features/conversation/job-status";
import { jobQueryOptions } from "@/features/conversation/queries";
import { useLiveEvent } from "@/lib/live";
import { contentKeys } from "./queries";

/** What each production job is doing, for the banner. */
export const JOB_LABELS: Partial<Record<JobType, string>> = {
  "content.write_script": "Writing the script",
  "content.storyboard": "Laying out the storyboard",
  "content.voice": "Recording the voice",
  "content.render": "Rendering the video",
  "content.revise": "Revising from the review",
};

export function jobLabel(type: JobType): string {
  return JOB_LABELS[type] ?? "Working on this video";
}

export interface JobProgress {
  summary: string;
  /** 0 to 1 when the job reports how far it is. */
  progress: number | undefined;
}

/**
 * The item's production job, kept current by `job.updated`, with its latest `job.activity`.
 * When the job finishes the item is read again for its new version and state.
 */
export function useItemJob(detail: ContentItemDetail | undefined) {
  const queryClient = useQueryClient();
  const itemId = detail?.item.id;
  const active = detail?.activeJob ?? null;
  const query = useQuery({
    ...jobQueryOptions(active?.id ?? ""),
    enabled: active !== null,
    placeholderData: active ?? undefined,
  });
  const job: JobSummary | null = active ? (query.data ?? active) : null;
  const [activity, setActivity] = useState<{ jobId: string; value: JobProgress } | null>(null);

  useLiveEvent("job.activity", ({ payload }) => {
    if (payload.jobId !== active?.id) return;
    setActivity({
      jobId: payload.jobId,
      value: { summary: payload.summary, progress: payload.progress },
    });
  });

  // A production job of this project started elsewhere (autopilot, another tab): read the item.
  useLiveEvent("job.updated", ({ payload }) => {
    if (!detail || !itemId) return;
    const { job: updated } = payload;
    if (updated.projectId !== detail.item.projectId || !updated.type.startsWith("content.")) return;
    if (updated.id === active?.id || isTerminal(updated.status)) return;
    void queryClient.invalidateQueries({ queryKey: contentKeys.detail(itemId) });
  });

  const finished = job !== null && isTerminal(job.status);
  useEffect(() => {
    if (finished && itemId) {
      void queryClient.invalidateQueries({ queryKey: contentKeys.detail(itemId) });
    }
  }, [finished, itemId, queryClient]);

  return {
    job: finished ? null : job,
    activity: activity && activity.jobId === active?.id ? activity.value : null,
  };
}
