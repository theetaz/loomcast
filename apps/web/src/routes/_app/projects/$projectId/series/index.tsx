import { Button } from "@loomcast/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ListVideoIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { seriesListQueryOptions } from "@/features/library/queries";
import { ProjectTabBody } from "@/features/project/ProjectLayout";

// Placeholder: the series pages replace this tab.
export const Route = createFileRoute("/_app/projects/$projectId/series/")({
  component: SeriesTab,
});

function SeriesTab() {
  const { projectId } = Route.useParams();
  return (
    <ProjectTabBody idOrSlug={projectId} title="Series">
      {(project) => <SeriesPlaceholder projectId={project.id} projectParam={projectId} />}
    </ProjectTabBody>
  );
}

function SeriesPlaceholder({
  projectId,
  projectParam,
}: {
  projectId: string;
  projectParam: string;
}) {
  const series = useQuery(seriesListQueryOptions(projectId));
  const names = (series.data?.items ?? []).map((entry) => entry.name);
  return (
    <section aria-label="Series" className="rounded-lg bg-card shadow-card">
      <EmptyState
        size="compact"
        icon={ListVideoIcon}
        title="Series pages are on their way"
        description={
          names.length > 0
            ? `This project has ${names.length === 1 ? "one series" : `${names.length} series`}: ${names.join(", ")}.`
            : "A series groups videos that share a format and a publishing cadence."
        }
        action={
          <Button asChild variant="outline">
            <Link to="/projects/$projectId/content" params={{ projectId: projectParam }}>
              Open content
            </Link>
          </Button>
        }
      />
    </section>
  );
}
