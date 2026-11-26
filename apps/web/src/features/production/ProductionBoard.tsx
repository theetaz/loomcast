import {
  type ContentProgress,
  PROGRESS_STEP_LABELS,
  PROGRESS_STEPS,
  type ProgressStepKey,
} from "@loomcast/contracts";
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleDashedIcon, FactoryIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { useWorkspaceParam } from "@/features/workspace/current";
import { ProgressPreview } from "./ProgressPreview";
import { StepBy, StepStrip } from "./ProgressSteps";
import { progressListQueryOptions, useProgressLive } from "./queries";

const ALL_STYLES = "";

/** Items in each step's column, in list order (most recently updated first). */
export function groupByStage(items: readonly ContentProgress[]) {
  const columns = new Map<ProgressStepKey, ContentProgress[]>(
    PROGRESS_STEPS.map((key) => [key, []]),
  );
  for (const item of items) {
    columns.get(item.stage)?.push(item);
  }
  return PROGRESS_STEPS.map((key) => ({ key, items: columns.get(key) ?? [] }));
}

/** The styles present, by how many items use them; items without one are left out. */
export function stylesOf(items: readonly ContentProgress[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.style) counts.set(item.style, (counts.get(item.style) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

/**
 * How the workspace's content is being made outside Loomcast: one column per production step,
 * each item under the step it is on. Read-only; producers move items by reporting progress.
 */
export function ProductionBoard({ workspaceId }: { workspaceId: string }) {
  useProgressLive();
  const query = useQuery(progressListQueryOptions(workspaceId));
  const [style, setStyle] = useState(ALL_STYLES);

  const items = useMemo(
    () => (query.data ?? []).filter((item) => item.itemState !== "archived"),
    [query.data],
  );
  const styles = useMemo(() => stylesOf(items), [items]);
  const shown = style === ALL_STYLES ? items : items.filter((item) => item.style === style);
  const failed = shown.filter((item) => item.health === "failed").length;
  const active = shown.filter((item) => item.health === "active").length;

  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load production progress"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (query.isPending) {
    return <div aria-busy="true" className="h-80 rounded-lg bg-secondary/50" />;
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={FactoryIcon}
        title="No production progress yet"
        description="Content made outside Loomcast shows up here once its producer reports it. For Content Machine, run cm content sync."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {styles.length > 0 ? (
          <fieldset className="flex flex-wrap gap-1.5">
            <legend className="sr-only">Video style</legend>
            {[ALL_STYLES, ...styles].map((value) => (
              <button
                key={value || "all"}
                type="button"
                aria-pressed={style === value}
                onClick={() => setStyle(value)}
                className={cn(
                  "h-7 rounded-full border px-3 text-small transition-colors",
                  style === value
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-card text-text-2 hover:bg-secondary",
                )}
              >
                {value || "All styles"}
              </button>
            ))}
          </fieldset>
        ) : null}
        <p className="ml-auto flex gap-3 text-small text-muted-foreground" aria-live="polite">
          <span>{shown.length} items</span>
          {active > 0 ? <span className="text-status-blue">{active} in progress</span> : null}
          {failed > 0 ? <span className="text-status-red">{failed} failed</span> : null}
        </p>
      </div>
      <ScrollArea
        role="region"
        aria-label="Production board"
        orientation="horizontal"
        viewportClassName="snap-x snap-mandatory scroll-px-3 sm:snap-none"
      >
        <ol className="flex w-max gap-2.5 p-3">
          {groupByStage(shown).map((column) => (
            <li
              key={column.key}
              aria-label={`${PROGRESS_STEP_LABELS[column.key]}, ${column.items.length} ${column.items.length === 1 ? "item" : "items"}`}
              className="flex w-[min(80vw,248px)] shrink-0 snap-start flex-col gap-2 rounded-lg bg-secondary/70 p-1.5"
            >
              <h3 className="flex h-7 items-center gap-2 px-1.5 text-small text-foreground">
                {PROGRESS_STEP_LABELS[column.key]}
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {column.items.length}
                </span>
              </h3>
              {column.items.length > 0 ? (
                <ul className="flex flex-col gap-1.5">
                  {column.items.map((item) => (
                    <ProgressCard key={item.itemId} item={item} />
                  ))}
                </ul>
              ) : (
                <p className="flex h-14 items-center justify-center rounded-md border border-border border-dashed text-small text-text-4">
                  Nothing here
                </p>
              )}
            </li>
          ))}
        </ol>
      </ScrollArea>
    </div>
  );
}

function ProgressCard({ item }: { item: ContentProgress }) {
  const workspaceParam = useWorkspaceParam();
  const failedStep = item.steps.find((step) => step.status === "failed");
  const stageStep = item.steps.find((step) => step.key === item.stage);
  return (
    <li
      data-item-id={item.itemId}
      className={cn(
        "relative flex gap-2.5 rounded-md bg-card p-2 shadow-card",
        "has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring",
        item.health === "failed" && "ring-1 ring-status-red/50",
      )}
    >
      {item.previewAssetId ? (
        <div className="w-11 shrink-0">
          <ProgressPreview assetId={item.previewAssetId} title={item.title} />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Link
          to="/w/$workspace/content/$itemId"
          params={{ workspace: workspaceParam, itemId: item.itemId }}
          className="line-clamp-2 font-medium text-[13px] text-foreground leading-snug outline-none after:absolute after:inset-0 after:rounded-md after:content-['']"
        >
          {item.title}
        </Link>
        <StepStrip steps={item.steps} />
        {stageStep ? (
          // Above the card's own link, so the skill and tool open the catalogue instead.
          <StepBy step={stageStep} className="relative z-10 w-fit max-w-full" />
        ) : null}
        <div className="flex min-w-0 items-center gap-1.5 text-small text-muted-foreground">
          {item.health === "failed" ? (
            <span
              title={failedStep?.error ?? "A step failed"}
              className="inline-flex text-status-red"
            >
              <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
              <span className="sr-only">Failed: {failedStep?.error ?? "a step failed"}</span>
            </span>
          ) : item.health === "active" ? (
            <LoaderCircleIcon
              aria-label="In progress"
              className="size-3.5 text-status-blue motion-safe:animate-spin"
            />
          ) : null}
          {item.inferred ? (
            <span title="Steps guessed from the files" className="inline-flex">
              <CircleDashedIcon aria-hidden="true" className="size-3.5" />
              <span className="sr-only">Guessed from the files</span>
            </span>
          ) : null}
          <span className="min-w-0 truncate">{item.style ?? "No style"}</span>
          <RelativeTime value={item.reportedAt} className="ml-auto shrink-0 text-[11px]" />
        </div>
      </div>
    </li>
  );
}
