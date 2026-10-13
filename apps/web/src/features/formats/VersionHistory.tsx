import type { FormatVersion } from "@loomcast/contracts";
import { Badge } from "@loomcast/ui/components/badge";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { diffJson, formatJsonValue, type JsonChange } from "./json-diff";
import { formatVersionsQueryOptions } from "./queries";

/**
 * Every version of a format, newest first. Opening one shows what it changed from the version
 * before, as a JSON diff of the rules: the path, the old value struck out and the new one.
 */
export function VersionHistory({
  formatId,
  currentVersionId,
}: {
  formatId: string;
  currentVersionId: string;
}) {
  const query = useQuery(formatVersionsQueryOptions(formatId));
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section
      aria-labelledby="format-history-title"
      className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-card shadow-card"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-divider border-b px-3.5">
        <h3 id="format-history-title" className="font-semibold text-[13px]">
          Version history
        </h3>
        {query.data ? (
          <span className="ml-auto text-small text-muted-foreground tabular-nums">
            {query.data.items.length}
          </span>
        ) : null}
      </div>
      {query.isPending ? (
        <div aria-hidden="true" className="flex flex-col gap-3 p-3.5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-28" />
        </div>
      ) : query.isError ? (
        <ErrorState
          size="compact"
          title="Couldn't load the history"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <ol className="flex flex-col">
          {query.data.items.map((version, index) => {
            const previous = query.data.items[index + 1];
            const open = openId === version.id;
            return (
              <li key={version.id} className="border-divider border-t first:border-t-0">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={`format-version-${version.id}`}
                  onClick={() => setOpenId(open ? null : version.id)}
                  className="flex h-10 w-full items-center gap-2 px-3.5 text-left text-control outline-none transition-colors hover:bg-secondary focus-visible:bg-secondary focus-visible:shadow-[inset_2px_0_0_var(--ring)]"
                >
                  <ChevronRightIcon
                    aria-hidden="true"
                    className={cn("size-3.5 shrink-0 text-text-4", open && "rotate-90")}
                  />
                  <span className="font-medium text-foreground">Version {version.versionNo}</span>
                  {version.id === currentVersionId ? (
                    <Badge variant="default">Current</Badge>
                  ) : null}
                  <RelativeTime
                    value={version.createdAt}
                    className="ml-auto font-mono text-[11px] text-muted-foreground"
                  />
                </button>
                {open ? (
                  <div id={`format-version-${version.id}`} className="px-3.5 pb-3">
                    <VersionDiff version={version} previous={previous} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function VersionDiff({
  version,
  previous,
}: {
  version: FormatVersion;
  previous: FormatVersion | undefined;
}) {
  if (!previous) {
    return <p className="text-small text-muted-foreground">The first version of this format.</p>;
  }
  const changes = diffJson(previous.rules, version.rules);
  if (changes.length === 0) {
    return (
      <p className="text-small text-muted-foreground">
        Same rules as version {previous.versionNo}, such as after a rename.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-small text-muted-foreground">
        {changes.length === 1 ? "One change" : `${changes.length} changes`} from version{" "}
        {previous.versionNo}
      </p>
      <ul aria-label={`Changes in version ${version.versionNo}`} className="flex flex-col gap-1">
        {changes.map((change) => (
          <DiffLine key={change.path} change={change} />
        ))}
      </ul>
    </div>
  );
}

const valueClass = "rounded-[4px] px-1 font-mono text-[11.5px] break-all no-underline";

function DiffLine({ change }: { change: JsonChange }) {
  return (
    <li className="flex flex-col gap-0.5 rounded-md bg-secondary px-2 py-1.5 shadow-[0_0_0_1px_var(--border)]">
      <code className="font-mono text-[11px] text-muted-foreground">{change.path}</code>
      <div className="flex flex-wrap items-baseline gap-1">
        {change.kind === "list" ? (
          <>
            {change.removed.map((value) => (
              <del
                key={`-${formatJsonValue(value)}`}
                className={cn(valueClass, "bg-status-red/11 text-status-red")}
              >
                <span aria-hidden="true">− </span>
                {formatJsonValue(value)}
              </del>
            ))}
            {change.added.map((value) => (
              <ins
                key={`+${formatJsonValue(value)}`}
                className={cn(valueClass, "bg-status-green/11 text-status-green")}
              >
                <span aria-hidden="true">+ </span>
                {formatJsonValue(value)}
              </ins>
            ))}
          </>
        ) : (
          <>
            {change.kind !== "added" ? (
              <del className={cn(valueClass, "bg-status-red/11 text-status-red line-through")}>
                {formatJsonValue(change.before)}
              </del>
            ) : null}
            {change.kind === "changed" ? (
              <span aria-hidden="true" className="text-text-4">
                →
              </span>
            ) : null}
            {change.kind !== "removed" ? (
              <ins className={cn(valueClass, "bg-status-green/11 text-status-green")}>
                {formatJsonValue(change.after)}
              </ins>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}
