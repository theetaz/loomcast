import type { Project } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ListVideoIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { seriesListQueryOptions } from "@/features/library/queries";
import { seriesQueryOptions } from "@/features/series/queries";
import { isApiError } from "@/lib/api";
import { useTitle } from "@/lib/use-title";
import { FormatEditor } from "./FormatEditor";
import { formatQueryOptions } from "./queries";
import { VersionHistory } from "./VersionHistory";

/** The rules of a series' format: the editor, with the version history beside it. */
export function FormatPage({
  project,
  projectParam,
  seriesId,
}: {
  project: Project;
  projectParam: string;
  seriesId: string;
}) {
  const series = useQuery(seriesQueryOptions(seriesId));
  const formatId = series.data?.formatId;
  const format = useQuery({ ...formatQueryOptions(formatId ?? ""), enabled: Boolean(formatId) });
  const allSeries = useQuery(seriesListQueryOptions(project.id));
  useTitle(series.data ? `Format · ${series.data.name}` : `Format · ${project.name}`);

  const back = (
    <Button asChild variant="ghost" size="sm" className="-ml-2 self-start">
      <Link
        to="/projects/$projectId/series/$seriesId"
        params={{ projectId: projectParam, seriesId }}
      >
        <ArrowLeftIcon aria-hidden="true" />
        {series.data?.name ?? "Series"}
      </Link>
    </Button>
  );

  const failed = series.error ?? format.error;
  if (failed || (series.data && series.data.projectId !== project.id)) {
    return isApiError(failed, 404) || !failed ? (
      <EmptyState
        icon={ListVideoIcon}
        title="Format not found"
        description="The series or its format may have been removed, or the link points somewhere else."
        action={
          <Button asChild variant="outline">
            <Link to="/projects/$projectId/series" params={{ projectId: projectParam }}>
              All series
            </Link>
          </Button>
        }
      />
    ) : (
      <ErrorState
        title="Couldn't load the format"
        error={failed}
        onRetry={() => {
          void series.refetch();
          void format.refetch();
        }}
        retrying={series.isFetching || format.isFetching}
      />
    );
  }

  if (!series.data || !format.data) {
    return (
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Skeleton className="h-5 w-40" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex flex-col gap-4">
            <Skeleton className="h-40 rounded-lg" />
            <Skeleton className="h-56 rounded-lg" />
          </div>
          <Skeleton className="h-40 rounded-lg" />
        </div>
      </div>
    );
  }

  const usedBy = (allSeries.data?.items ?? []).filter(
    (entry) => entry.formatId === format.data.id && entry.status !== "archived",
  );

  return (
    <div className="flex flex-col gap-3">
      {back}
      <div className="flex flex-col gap-0.5">
        <h2 className="text-heading">Format rules</h2>
        <p className="text-control text-muted-foreground">
          How every video of {series.data.name} is written, voiced, styled and published.
        </p>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <FormatEditor
          key={format.data.id}
          format={format.data}
          usedBy={usedBy}
          readOnly={project.status !== "active"}
        />
        <div className="lg:sticky lg:top-4">
          <VersionHistory
            formatId={format.data.id}
            currentVersionId={format.data.currentVersion.id}
          />
        </div>
      </div>
    </div>
  );
}
