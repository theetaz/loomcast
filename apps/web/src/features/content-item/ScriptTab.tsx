import type { Script } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { FileTextIcon, PencilIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { LengthSummary } from "./LengthSummary";
import { versionQueryOptions } from "./queries";
import { ScriptDiff } from "./ScriptDiff";
import type { ItemTabProps } from "./tab-props";
import { formatSpan, timeSegments } from "./timing";

const ScriptEditor = lazy(() =>
  import("./ScriptEditor").then((module) => ({ default: module.ScriptEditor })),
);

/** The script: timestamped segments, the hook, length against the format, edit and compare. */
export function ScriptTab(
  props: ItemTabProps & { compareId: string | undefined; onCompare: (id?: string) => void },
) {
  const { detail, version, canEdit, editBlocked, decisions, rules, compareId, onCompare } = props;
  const [editing, setEditing] = useState(false);
  const script = version.script;
  const speed = rules?.voiceSpeed ?? 1;

  if (!script) {
    return (
      <EmptyState
        size="compact"
        icon={FileTextIcon}
        title="No script yet"
        description="The studio agent writes the script from the idea and the format's rules."
        action={
          decisions.can("write_script") && props.viewingCurrent ? (
            <Button
              type="button"
              disabled={decisions.busy || decisions.hasActiveJob}
              onClick={() => decisions.start("write_script")}
            >
              Write the script
            </Button>
          ) : null
        }
      />
    );
  }

  if (editing && canEdit) {
    return (
      <Suspense fallback={<ScriptSkeleton />}>
        <ScriptEditor
          detail={detail}
          base={version}
          rules={rules}
          onDone={() => setEditing(false)}
        />
      </Suspense>
    );
  }

  const scripted = detail.versions.filter((entry) => entry.hasScript && entry.id !== version.id);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-divider border-b px-4 py-2.5">
        <LengthSummary script={script} speed={speed} target={rules?.lengthSec ?? null} />
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {scripted.length > 0 ? (
            <Select
              value={compareId ?? ""}
              onValueChange={(value) => onCompare(value || undefined)}
            >
              <SelectTrigger size="sm" aria-label="Compare with a version" className="w-auto">
                <SelectValue placeholder="Compare with…" />
              </SelectTrigger>
              <SelectContent align="end">
                {scripted.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    Compare with v{entry.versionNo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canEdit}
            title={editBlocked ?? undefined}
            onClick={() => setEditing(true)}
          >
            <PencilIcon aria-hidden="true" />
            Edit script
          </Button>
        </div>
      </div>
      {compareId ? (
        <ScriptCompare
          itemId={detail.item.id}
          viewed={{ script, versionNo: version.versionNo }}
          compareId={compareId}
          onClose={() => onCompare(undefined)}
        />
      ) : (
        <ScriptView script={script} speed={speed} />
      )}
    </div>
  );
}

function ScriptCompare({
  itemId,
  viewed,
  compareId,
  onClose,
}: {
  itemId: string;
  viewed: { script: Script; versionNo: number };
  compareId: string;
  onClose: () => void;
}) {
  const query = useQuery(versionQueryOptions(itemId, compareId));
  if (query.isPending) return <ScriptSkeleton />;
  if (query.isError) {
    return (
      <ErrorState
        size="compact"
        title="Couldn't load that version"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const other = query.data;
  if (!other.script) {
    return (
      <EmptyState
        size="compact"
        icon={FileTextIcon}
        title={`v${other.versionNo} has no script`}
        action={
          <Button type="button" variant="outline" onClick={onClose}>
            Close compare
          </Button>
        }
      />
    );
  }
  // Always read from the older version to the newer one.
  const older = other.versionNo < viewed.versionNo;
  return (
    <ScriptDiff
      before={older ? other.script : viewed.script}
      after={older ? viewed.script : other.script}
      beforeLabel={`v${older ? other.versionNo : viewed.versionNo}`}
      afterLabel={`v${older ? viewed.versionNo : other.versionNo}`}
      onClose={onClose}
    />
  );
}

/** Segments with timestamps; the opening segment carries the hook and is highlighted. */
function ScriptView({ script, speed }: { script: Script; speed: number }) {
  const timed = timeSegments(script.segments, speed);
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="rounded-md bg-ember/8 px-3 py-2.5">
        <p className="font-medium text-[11px] text-ember uppercase tracking-wide">Hook</p>
        <p className="mt-0.5 text-body text-foreground">{script.hook}</p>
      </div>
      <ol className="flex flex-col" aria-label="Segments">
        {timed.map(({ segment, startMs, endMs, measured }, index) => (
          <li
            key={segment.id}
            className={cn(
              "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-divider border-t py-2.5 first:border-t-0",
              index === 0 && "-mx-1 rounded-md border-t-0 bg-ember/5 px-1",
            )}
          >
            <span
              className="pt-0.5 font-mono text-mono text-text-4 tabular-nums"
              title={measured ? "From the voice" : "Estimated from the word count"}
            >
              {measured ? "" : "~"}
              {formatSpan(startMs, endMs)}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <p className="break-words text-body text-foreground">{segment.text}</p>
              {segment.onScreenText ? (
                <p className="flex items-baseline gap-1.5 text-small text-muted-foreground">
                  <span className="shrink-0 font-medium text-[11px] uppercase tracking-wide">
                    On screen
                  </span>
                  <span className="min-w-0 break-words font-mono text-mono text-text-2">
                    {segment.onScreenText}
                  </span>
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 border-divider border-t pt-3 text-small">
        <dt className="text-muted-foreground">Call to action</dt>
        <dd className="break-words text-foreground">{script.cta || "None"}</dd>
        <dt className="text-muted-foreground">Caption</dt>
        <dd className="whitespace-pre-wrap break-words text-foreground">
          {script.caption || "None"}
        </dd>
        <dt className="text-muted-foreground">Hashtags</dt>
        <dd className="break-words text-text-2">
          {script.hashtags.length > 0 ? script.hashtags.map((tag) => `#${tag}`).join(" ") : "None"}
        </dd>
      </dl>
    </div>
  );
}

export function ScriptSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 px-4 py-4">
      <Skeleton className="h-12 rounded-md" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  );
}
