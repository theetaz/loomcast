import type { KbEntry, Project } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { cn } from "@loomcast/ui/lib/cn";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlusIcon, ReplaceIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { formatDateTime } from "@/lib/format";
import { DecisionPill, decisionOf } from "./decisions";
import { KbRowsSkeleton } from "./KbRow";
import { KIND_META } from "./kinds";
import { kbListQueryOptions } from "./queries";

const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * The project's decisions as a timeline, newest first. Active decisions can be superseded;
 * superseded ones link to what replaced them.
 */
export function DecisionLog({ project, projectParam }: { project: Project; projectParam: string }) {
  const list = useInfiniteQuery(kbListQueryOptions(project.id, { kind: "decision", tag: null }));

  if (list.isPending) return <KbRowsSkeleton rows={4} />;
  if (list.isError) {
    return (
      <ErrorState
        size="compact"
        title="Couldn't load the decisions"
        error={list.error}
        onRetry={() => void list.refetch()}
        retrying={list.isFetching}
      />
    );
  }

  const decisions = list.data.pages
    .flatMap((page) => page.items)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const titles = new Map(decisions.map((entry) => [entry.id, entry.title]));
  const record = (
    <Button asChild>
      <Link
        to="/projects/$projectId/kb/new"
        params={{ projectId: projectParam }}
        search={{ kind: "decision" }}
      >
        <PlusIcon aria-hidden="true" />
        Record decision
      </Link>
    </Button>
  );

  if (decisions.length === 0) {
    return (
      <EmptyState
        size="compact"
        icon={KIND_META.decision.icon}
        title="No decisions yet"
        description="Record what you decided and why, so later scripts stay consistent."
        action={record}
      />
    );
  }

  const active = decisions.filter((entry) => decisionOf(entry).status === "active").length;

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 border-divider border-b px-3.5 py-2.5">
        <p className="min-w-0 flex-1 text-small text-muted-foreground">
          {active} active · {decisions.length - active} superseded
        </p>
        <Button asChild variant="outline" size="sm">
          <Link
            to="/projects/$projectId/kb/new"
            params={{ projectId: projectParam }}
            search={{ kind: "decision" }}
          >
            <PlusIcon aria-hidden="true" />
            Record decision
          </Link>
        </Button>
      </div>
      <ol aria-label="Decision log" className="flex flex-col px-3.5 pt-4">
        {decisions.map((entry, index) => (
          <DecisionItem
            key={entry.id}
            entry={entry}
            projectParam={projectParam}
            last={index === decisions.length - 1}
            supersededByTitle={(id) => titles.get(id)}
          />
        ))}
      </ol>
      {list.hasNextPage ? (
        <div className="flex justify-center border-divider border-t p-2">
          <Button
            variant="ghost"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DecisionItem({
  entry,
  projectParam,
  last,
  supersededByTitle,
}: {
  entry: KbEntry;
  projectParam: string;
  last: boolean;
  supersededByTitle: (id: string) => string | undefined;
}) {
  const data = decisionOf(entry);
  const superseded = data.status === "superseded";
  return (
    <li className="grid grid-cols-[12px_minmax(0,1fr)] gap-x-3">
      <div aria-hidden="true" className="flex flex-col items-center">
        <span
          className={cn(
            "mt-[5px] size-2.5 shrink-0 rounded-full shadow-[0_0_0_3px_var(--card)]",
            superseded ? "bg-status-gray/50" : "bg-status-violet",
          )}
        />
        {last ? null : <span className="w-px flex-1 bg-divider" />}
      </div>
      <article className={cn("flex min-w-0 flex-col gap-1", last ? "pb-4" : "pb-5")}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted-foreground">
          <time
            dateTime={entry.createdAt}
            title={formatDateTime(entry.createdAt)}
            className="tabular-nums"
          >
            {dateFormat.format(Date.parse(entry.createdAt))}
          </time>
          <DecisionPill status={data.status} />
        </div>
        <h3 className="min-w-0">
          <Link
            to="/projects/$projectId/kb/$entryId"
            params={{ projectId: projectParam, entryId: entry.id }}
            className={cn(
              "rounded-sm font-medium text-body outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
              superseded ? "text-text-2" : "text-foreground",
            )}
          >
            {entry.title}
          </Link>
        </h3>
        <p
          className={cn(
            "line-clamp-3 max-w-[72ch] whitespace-pre-line break-words text-body",
            superseded ? "text-muted-foreground" : "text-text-2",
          )}
        >
          {data.decision}
        </p>
        {data.rationale ? (
          <p className="line-clamp-2 max-w-[72ch] break-words text-small text-muted-foreground">
            Why: {data.rationale}
          </p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {superseded ? (
            data.supersededBy ? (
              <Link
                to="/projects/$projectId/kb/$entryId"
                params={{ projectId: projectParam, entryId: data.supersededBy }}
                className="inline-flex min-w-0 items-center gap-1 rounded-sm text-small text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ReplaceIcon aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate">
                  Superseded by {supersededByTitle(data.supersededBy) ?? "a later decision"}
                </span>
              </Link>
            ) : null
          ) : (
            <Button asChild variant="ghost" size="xs" className="-ml-2">
              <Link
                to="/projects/$projectId/kb/new"
                params={{ projectId: projectParam }}
                search={{ kind: "decision", supersedes: entry.id }}
                aria-label={`Supersede “${entry.title}”`}
              >
                <ReplaceIcon aria-hidden="true" />
                Supersede
              </Link>
            </Button>
          )}
        </div>
      </article>
    </li>
  );
}
