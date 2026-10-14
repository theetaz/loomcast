import type { Competitor, Project } from "@loomcast/contracts";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileTextIcon, TelescopeIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { PlatformTile, platformLabel } from "@/features/channels/platforms";
import { AddCompetitorForm } from "./AddCompetitorForm";
import { competitorsQueryOptions } from "./queries";
import { accountFacts, competitorLabel, competitorName, ScanStatusPill } from "./status";

/** The Competitors tab: the profiles the project follows, and a way to follow another. */
export function CompetitorsPage({
  project,
  projectParam,
}: {
  project: Project;
  projectParam: string;
}) {
  const query = useQuery(competitorsQueryOptions(project.id));
  const competitors = query.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="text-heading">Competitors</h2>
        <p className="text-control text-muted-foreground">
          Profiles worth learning from. A scan analyses their most popular videos and writes a
          report to the knowledge base.
        </p>
      </div>

      {project.status === "active" ? <AddCompetitorForm projectId={project.id} /> : null}

      <section aria-label="Competitors" className="overflow-hidden rounded-lg bg-card shadow-card">
        {query.isPending ? (
          <CompetitorRowsSkeleton />
        ) : query.isError ? (
          <ErrorState
            size="compact"
            title="Couldn't load the competitors"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : competitors.length === 0 ? (
          <EmptyState
            size="compact"
            icon={TelescopeIcon}
            title="No competitors yet"
            description="Add a profile above to see which of its videos work best, and why."
          />
        ) : (
          <ul aria-label="Followed competitors">
            {competitors.map((competitor) => (
              <CompetitorRow
                key={competitor.id}
                competitor={competitor}
                projectParam={projectParam}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CompetitorRow({
  competitor,
  projectParam,
}: {
  competitor: Competitor;
  projectParam: string;
}) {
  const facts = accountFacts(competitor.account);
  const scan = competitor.latestScan;
  return (
    <li
      aria-label={competitorLabel(competitor)}
      className="flex items-center gap-3 border-divider border-t px-3.5 py-2.5 first:border-t-0"
    >
      <PlatformTile platform={competitor.platform} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link
          to="/projects/$projectId/competitors/$competitorId"
          params={{ projectId: projectParam, competitorId: competitor.id }}
          className={cn(
            "min-w-0 truncate rounded-sm font-medium text-body text-foreground outline-none",
            "hover:underline focus-visible:ring-2 focus-visible:ring-ring underline-offset-2",
          )}
        >
          {competitorName(competitor)}
        </Link>
        <p className="min-w-0 truncate text-small text-muted-foreground">
          {[platformLabel(competitor.platform), competitor.account.displayName, ...facts]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {scan ? (
          <span className="flex items-center gap-2">
            <span className="sr-only">Latest scan:</span>
            <ScanStatusPill status={scan.status} />
            <RelativeTime
              value={scan.createdAt}
              className="hidden w-12 text-right font-mono text-[11px] text-muted-foreground sm:inline"
            />
          </span>
        ) : (
          <span className="text-small text-muted-foreground">Not scanned</span>
        )}
        {competitor.latestReportEntryId ? (
          <Link
            to="/projects/$projectId/kb/$entryId"
            params={{ projectId: projectParam, entryId: competitor.latestReportEntryId }}
            aria-label={`Report on ${competitorName(competitor)}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-sm text-primary text-small outline-none",
              "hover:underline focus-visible:ring-2 focus-visible:ring-ring underline-offset-2",
            )}
          >
            <FileTextIcon aria-hidden="true" className="size-3.5" />
            Report
          </Link>
        ) : null}
      </div>
    </li>
  );
}

const SKELETON_WIDTHS = ["32%", "44%", "26%"];

function CompetitorRowsSkeleton() {
  return (
    <div aria-hidden="true">
      {SKELETON_WIDTHS.map((width) => (
        <div
          key={width}
          className="flex items-center gap-3 border-divider border-t px-3.5 py-2.5 first:border-t-0"
        >
          <Skeleton className="size-7 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3" style={{ width }} />
            <Skeleton className="h-2.5 w-40" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}
