import {
  type ContentProgress,
  PROGRESS_STEP_LABELS,
  type ProgressCheck,
  type ProgressStep,
  type ProgressStepStatus,
} from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";
import {
  CheckIcon,
  CircleDashedIcon,
  CircleIcon,
  LoaderCircleIcon,
  MinusIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import { SkillName, ToolName } from "@/features/skills/links";
import { useOptionalWorkspaceParam } from "@/features/workspace/current";

const STATUS_LABELS: Record<ProgressStepStatus, string> = {
  pending: "To do",
  active: "In progress",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

/** The small mark of a step's status, with its name for screen readers. */
export function StepMark({
  status,
  className,
}: {
  status: ProgressStepStatus;
  className?: string;
}) {
  const base = cn("size-3.5 shrink-0", className);
  const mark =
    status === "done" ? (
      <CheckIcon aria-hidden="true" className={cn(base, "text-status-green")} />
    ) : status === "active" ? (
      <LoaderCircleIcon
        aria-hidden="true"
        className={cn(base, "text-status-blue motion-safe:animate-spin")}
      />
    ) : status === "failed" ? (
      <XIcon aria-hidden="true" className={cn(base, "text-status-red")} />
    ) : status === "skipped" ? (
      <MinusIcon aria-hidden="true" className={cn(base, "text-text-4")} />
    ) : (
      <CircleIcon aria-hidden="true" className={cn(base, "text-text-4")} />
    );
  return (
    <>
      {mark}
      <span className="sr-only">{STATUS_LABELS[status]}</span>
    </>
  );
}

/** One dot per step, coloured by status: the compact strip on a board card. */
export function StepStrip({ steps }: { steps: readonly ProgressStep[] }) {
  return (
    <ol aria-label="Steps" className="flex items-center gap-[3px]">
      {steps.map((step) => (
        <li
          key={step.key}
          title={`${PROGRESS_STEP_LABELS[step.key]}: ${STATUS_LABELS[step.status]}`}
          className={cn(
            "h-1.5 flex-1 rounded-full",
            step.status === "done" && "bg-status-green",
            step.status === "active" && "bg-status-blue",
            step.status === "failed" && "bg-status-red",
            step.status === "skipped" && "bg-border",
            step.status === "pending" && "bg-secondary",
          )}
        >
          <span className="sr-only">
            {PROGRESS_STEP_LABELS[step.key]}: {STATUS_LABELS[step.status]}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The skill and tool behind a step, linked to the skills catalogue and the workspace's tools. */
export function StepBy({ step, className }: { step: ProgressStep; className?: string }) {
  const workspace = useOptionalWorkspaceParam();
  if (step.skill === null && step.tool === null) return null;
  const text = "text-[11px] text-muted-foreground";
  return (
    <p className={cn("flex min-w-0 items-baseline gap-1 truncate font-mono", text, className)}>
      {step.skill !== null ? <SkillName name={step.skill} className={text} /> : null}
      {step.skill !== null && step.tool !== null ? <span aria-hidden="true">·</span> : null}
      {step.tool !== null ? (
        workspace === null ? (
          <span>{step.tool}</span>
        ) : (
          <ToolName name={step.tool} workspace={workspace} className={text} />
        )
      ) : null}
    </p>
  );
}

function StepRow({ step }: { step: ProgressStep }) {
  return (
    <li className="flex gap-2.5 py-1.5">
      <span className="mt-0.5">
        <StepMark status={step.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-body",
              step.status === "pending" || step.status === "skipped"
                ? "text-muted-foreground"
                : "text-foreground",
            )}
          >
            {PROGRESS_STEP_LABELS[step.key]}
          </span>
          {(step.finishedAt ?? step.startedAt) ? (
            <RelativeTime
              value={(step.finishedAt ?? step.startedAt) as string}
              className="ml-auto shrink-0 text-small text-muted-foreground"
            />
          ) : null}
        </div>
        <StepBy step={step} />
        {step.note ? <p className="text-small text-text-2">{step.note}</p> : null}
        {step.error ? <p className="text-small text-status-red">{step.error}</p> : null}
      </div>
    </li>
  );
}

function CheckRow({ check }: { check: ProgressCheck }) {
  return (
    <li className="flex gap-2.5 py-1">
      {check.status === "pass" ? (
        <CheckIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-status-green" />
      ) : check.status === "warn" ? (
        <TriangleAlertIcon
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-status-amber"
        />
      ) : (
        <XIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-status-red" />
      )}
      <div className="min-w-0">
        <span className="text-body text-foreground">
          {check.name}
          <span className="sr-only"> ({check.status})</span>
        </span>
        {check.detail ? <p className="text-small text-text-2">{check.detail}</p> : null}
      </div>
    </li>
  );
}

/** Every step with who made it and when, then the checks: the item page's production card. */
export function ProgressDetail({ progress }: { progress: ContentProgress }) {
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Production steps" className="flex flex-col">
        {progress.steps.map((step) => (
          <StepRow key={step.key} step={step} />
        ))}
      </ol>
      {progress.checks.length > 0 ? (
        <section aria-label="Checks" className="border-divider border-t pt-2">
          <h3 className="text-small text-muted-foreground">Checks</h3>
          <ul className="flex flex-col">
            {progress.checks.map((check) => (
              <CheckRow key={check.name} check={check} />
            ))}
          </ul>
        </section>
      ) : null}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-divider border-t pt-2 text-small text-muted-foreground">
        {progress.inferred ? (
          <span className="inline-flex items-center gap-1">
            <CircleDashedIcon aria-hidden="true" className="size-3.5" />
            Guessed from the files
          </span>
        ) : null}
        <span className="min-w-0 truncate font-mono text-[11px]" title={progress.path}>
          {progress.path}
        </span>
        <span className="ml-auto">
          {progress.source}, <RelativeTime value={progress.reportedAt} format="relative" />
        </span>
      </p>
    </div>
  );
}
