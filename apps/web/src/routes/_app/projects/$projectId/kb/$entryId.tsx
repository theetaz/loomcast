import { IdSchema } from "@loomcast/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { KbEntryCrumb } from "@/features/kb/KbEntryCrumb";
import { KbEntryPage } from "@/features/kb/KbEntryPage";
import { ProjectTabBody } from "@/features/project/ProjectLayout";

export const Route = createFileRoute("/_app/projects/$projectId/kb/$entryId")({
  staticData: { breadcrumb: (params) => <KbEntryCrumb id={params.entryId ?? ""} /> },
  component: EntryRoute,
});

function EntryRoute() {
  const { projectId, entryId } = Route.useParams();
  return (
    <ProjectTabBody idOrSlug={projectId} title={null}>
      {(project) => (
        <KbEntryPage
          key={entryId}
          project={project}
          projectParam={projectId}
          entryId={IdSchema.safeParse(entryId).success ? entryId : null}
        />
      )}
    </ProjectTabBody>
  );
}
