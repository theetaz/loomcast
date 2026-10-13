import type { ReferenceAnalysis } from "@loomcast/contracts";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { SparklesIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { AnalysisState } from "./analysis-status";

/** `m:ss` for a position in the video. */
export function formatPosition(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-divider border-t px-3.5 py-3 first:border-t-0">
      <h4 className="font-medium text-small text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

/** The structured analysis of a reference: hook, structure, pacing, retention and takeaways. */
export function AnalysisPane({
  analysis,
  state,
}: {
  analysis: ReferenceAnalysis | null;
  state: AnalysisState;
}) {
  return (
    <section
      aria-label="Analysis"
      aria-busy={state.busy || undefined}
      className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-card shadow-card"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-divider border-b px-3.5">
        <h3 className="font-semibold text-[13px]">Analysis</h3>
      </div>
      {analysis ? (
        <AnalysisBody analysis={analysis} />
      ) : state.busy ? (
        <div className="flex flex-col gap-3 p-3.5" aria-hidden="true">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="mt-2 h-3 w-24" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ) : state.status === "failed" ? (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <TriangleAlertIcon aria-hidden="true" className="size-5 text-status-red" />
          <p className="max-w-sm text-control text-muted-foreground">{state.hint}</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <SparklesIcon aria-hidden="true" className="size-5 text-muted-foreground" />
          <p className="max-w-sm text-control text-muted-foreground">
            Not analyzed yet. Analyze reads the transcript and breaks down the hook, structure,
            pacing and what keeps viewers watching.
          </p>
        </div>
      )}
    </section>
  );
}

function AnalysisBody({ analysis }: { analysis: ReferenceAnalysis }) {
  const { hook, structure, pacing, retention, takeaways } = analysis;
  const timed = structure.filter(
    (section) => section.startMs !== undefined && section.endMs !== undefined,
  );
  const total = timed.reduce((max, section) => Math.max(max, section.endMs ?? 0), 0);

  return (
    <div className="flex flex-col">
      <Section title="Hook">
        <blockquote className="border-primary/40 border-l-2 pl-3 text-body text-foreground">
          {hook.text}
        </blockquote>
        <p className="flex flex-wrap items-center gap-2 text-small text-muted-foreground">
          <span className="rounded-full bg-secondary px-2 font-mono text-[11px] leading-5 shadow-[0_0_0_1px_var(--border)]">
            {hook.type}
          </span>
          {hook.timeToHookMs !== undefined ? (
            <span>Lands at {formatPosition(hook.timeToHookMs)}</span>
          ) : null}
        </p>
      </Section>

      {structure.length > 0 ? (
        <Section title="Structure">
          {total > 0 && timed.length === structure.length ? (
            <div
              aria-hidden="true"
              className="flex h-1.5 w-full gap-px overflow-hidden rounded-full"
            >
              {timed.map((section, index) => (
                <span
                  key={`${section.label}-${section.startMs}`}
                  className={index % 2 === 0 ? "bg-primary/70" : "bg-primary/35"}
                  style={{
                    width: `${(((section.endMs ?? 0) - (section.startMs ?? 0)) / total) * 100}%`,
                  }}
                />
              ))}
            </div>
          ) : null}
          <ol className="flex flex-col gap-2">
            {structure.map((section, index) => (
              <li key={index} className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 text-body">
                <span className="pt-px font-mono text-[11px] text-muted-foreground tabular-nums">
                  {section.startMs !== undefined ? formatPosition(section.startMs) : "–"}
                  {section.endMs !== undefined ? `–${formatPosition(section.endMs)}` : ""}
                </span>
                <span className="min-w-0 break-words">
                  <span className="font-medium text-foreground">{section.label}.</span>{" "}
                  <span className="text-text-2">{section.summary}</span>
                </span>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      <Section title="Pacing">
        {pacing.wordsPerMinute !== undefined || pacing.cutsPerMinute !== undefined ? (
          <dl className="flex flex-wrap gap-x-6 gap-y-1">
            {pacing.wordsPerMinute !== undefined ? (
              <div className="flex items-baseline gap-1.5">
                <dt className="sr-only">Words per minute</dt>
                <dd className="font-semibold text-heading tabular-nums">
                  {Math.round(pacing.wordsPerMinute)}
                </dd>
                <span aria-hidden="true" className="text-small text-muted-foreground">
                  words/min
                </span>
              </div>
            ) : null}
            {pacing.cutsPerMinute !== undefined ? (
              <div className="flex items-baseline gap-1.5">
                <dt className="sr-only">Cuts per minute</dt>
                <dd className="font-semibold text-heading tabular-nums">
                  {Math.round(pacing.cutsPerMinute)}
                </dd>
                <span aria-hidden="true" className="text-small text-muted-foreground">
                  cuts/min
                </span>
              </div>
            ) : null}
          </dl>
        ) : null}
        {pacing.notes ? <p className="text-body text-text-2">{pacing.notes}</p> : null}
      </Section>

      {retention.length > 0 ? (
        <Section title="Retention">
          <ul className="flex flex-col gap-1.5">
            {retention.map((item, index) => (
              <li key={index} className="text-body">
                <span className="font-medium text-foreground">{item.technique}.</span>{" "}
                <span className="text-text-2">{item.evidence}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {analysis.visualStyle || analysis.cta ? (
        <Section title="Style and call to action">
          {analysis.visualStyle ? (
            <p className="text-body text-text-2">{analysis.visualStyle}</p>
          ) : null}
          {analysis.cta ? (
            <p className="text-body text-text-2">
              <span className="text-muted-foreground">Call to action: </span>
              {analysis.cta}
            </p>
          ) : null}
        </Section>
      ) : null}

      <Section title="Takeaways">
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-body marker:text-muted-foreground">
          {takeaways.map((takeaway, index) => (
            <li key={index} className="pl-0.5 text-foreground">
              {takeaway}
            </li>
          ))}
        </ol>
      </Section>

      <Section title="For this project">
        <p className="text-body text-text-2">{analysis.applicability}</p>
      </Section>
    </div>
  );
}
