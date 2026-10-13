import { IdSchema } from "@loomcast/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { CREATABLE_KINDS } from "@/features/kb/kinds";
import { NewEntryPage } from "@/features/kb/NewEntryPage";
import { ProjectTabBody } from "@/features/project/ProjectLayout";

const newEntrySearchSchema = z.object({
  kind: z.enum(CREATABLE_KINDS).catch("brainstorm"),
  supersedes: IdSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/_app/projects/$projectId/kb/new")({
  validateSearch: newEntrySearchSchema,
  staticData: { breadcrumb: "New entry" },
  component: NewEntryRoute,
});

function NewEntryRoute() {
  const { projectId } = Route.useParams();
  const { kind, supersedes } = Route.useSearch();
  return (
    <ProjectTabBody idOrSlug={projectId} title={null}>
      {(project) => (
        <NewEntryPage
          project={project}
          projectParam={projectId}
          kind={kind}
          supersedes={supersedes}
        />
      )}
    </ProjectTabBody>
  );
}
