import {
  type KbEntryDetail,
  type KbReferenceDetail,
  TERMINAL_JOB_STATUSES,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { StatusPill } from "@loomcast/ui/components/StatusPill";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, SparklesIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/RelativeTime";
import { jobQueryOptions } from "@/features/conversation/queries";
import { api, errorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { AnalysisPane } from "./AnalysisPane";
import { analysisState } from "./analysis-status";
import { DeleteEntryButton, EntryMeta, EntryToolbar, TagChips } from "./EntryChrome";
import { PLATFORM_META } from "./kinds";
import { kbKeys } from "./queries";
import { TranscriptPane } from "./TranscriptPane";

function isTerminal(status: string | undefined): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status ?? "");
}

/** The latest analysis job of a reference, kept current by `job.updated` events. */
function useAnalysisJob(entry: KbEntryDetail, reference: KbReferenceDetail) {
  const queryClient = useQueryClient();
  const jobId = reference.analysisJobId;
  const job = useQuery({ ...jobQueryOptions(jobId ?? ""), enabled: jobId !== null });

  // When the job finishes, fetch the reference again for the stored analysis.
  const status = job.data?.status;
  const previous = useRef(status);
  useEffect(() => {
    if (status !== previous.current && isTerminal(status) && previous.current !== undefined) {
      void queryClient.invalidateQueries({ queryKey: kbKeys.detail(entry.id) });
    }
    previous.current = status;
  }, [status, entry.id, queryClient]);

  return job.data;
}

/**
 * A saved reference video: where it is, why it was saved, its transcript and its analysis. The
 * link opens in a new tab without a referrer; Loomcast itself never fetches it.
 */
export function ReferenceView({
  entry,
  projectParam,
}: {
  entry: KbEntryDetail;
  projectParam: string;
}) {
  const queryClient = useQueryClient();
  const reference = entry.reference ?? {
    url: entry.sourceUrl ?? "",
    platform: "other" as const,
    author: null,
    likedReason: null,
    transcript: null,
    analysis: null,
    analysisStatus: "none" as const,
    analysisJobId: null,
    analyzedAt: null,
  };
  const job = useAnalysisJob(entry, reference);
  const state = analysisState(reference, job);
  const platform = PLATFORM_META[reference.platform];

  const analyze = useMutation({
    mutationFn: () => api.request("kb.analyze", { params: { id: entry.id } }),
    onSuccess: (started) => {
      queryClient.setQueryData(queryKeys.jobs.detail(started.id), started);
      queryClient.setQueryData<KbEntryDetail>(kbKeys.detail(entry.id), (current) =>
        current?.reference
          ? {
              ...current,
              reference: {
                ...current.reference,
                analysisJobId: started.id,
                analysisStatus: "queued",
              },
            }
          : current,
      );
    },
    onError: (error) =>
      toast.error("Couldn't start the analysis", { description: errorMessage(error) }),
  });

  return (
    <article className="flex flex-col gap-4">
      <EntryToolbar projectParam={projectParam}>
        <DeleteEntryButton entry={entry} projectParam={projectParam} />
      </EntryToolbar>

      <header className="flex flex-col gap-2">
        <EntryMeta entry={entry} />
        <h2 className="text-title break-words">{entry.title}</h2>
        <TagChips tags={entry.tags} />
      </header>

      <div className="flex flex-col gap-3 rounded-lg bg-card px-3.5 py-3 shadow-card">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="inline-flex items-center gap-1.5 font-medium text-body">
            <platform.icon aria-hidden="true" className="size-4 text-muted-foreground" />
            {platform.label}
          </span>
          {reference.author ? (
            <span className="min-w-0 truncate text-body text-text-2">{reference.author}</span>
          ) : null}
          <a
            href={reference.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm text-primary text-small underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:ml-auto"
          >
            <span className="truncate font-mono text-[11.5px]">{reference.url}</span>
            <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
        {reference.likedReason ? (
          <div className="flex flex-col gap-0.5">
            <p className="text-small text-muted-foreground">Why it was saved</p>
            <p className="whitespace-pre-line break-words text-body text-foreground">
              {reference.likedReason}
            </p>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-divider border-t pt-3">
          {state.status ? (
            <StatusPill kind="job" status={state.status}>
              {state.label}
            </StatusPill>
          ) : (
            <span className="text-small text-muted-foreground">Not analyzed</span>
          )}
          {reference.analyzedAt && !state.busy ? (
            <span className="text-small text-muted-foreground">
              Analyzed <RelativeTime value={reference.analyzedAt} format="relative" />
            </span>
          ) : null}
          {state.hint ? (
            <span className="min-w-0 text-small text-muted-foreground">{state.hint}</span>
          ) : null}
          <Button
            variant={state.action === "Analyze" ? "default" : "outline"}
            size="sm"
            className="ml-auto"
            disabled={!state.canAnalyze || analyze.isPending}
            onClick={() => analyze.mutate()}
          >
            <SparklesIcon aria-hidden="true" />
            {analyze.isPending ? "Starting…" : state.action}
          </Button>
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <TranscriptPane entry={entry} />
        <AnalysisPane analysis={reference.analysis} state={state} />
      </div>
    </article>
  );
}
