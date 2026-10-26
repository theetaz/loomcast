import { IdSchema } from "@loomcast/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { CREATABLE_KINDS } from "@/features/kb/kinds";
import { NewEntryPage } from "@/features/kb/NewEntryPage";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

const newEntrySearchSchema = z.object({
  kind: z.enum(CREATABLE_KINDS).catch("brainstorm"),
  supersedes: IdSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/_app/w/$workspace/kb/new")({
  validateSearch: newEntrySearchSchema,
  staticData: { breadcrumb: "New entry" },
  component: NewEntryRoute,
});

function NewEntryRoute() {
  const { workspace: workspaceParam } = Route.useParams();
  const { kind, supersedes } = Route.useSearch();
  return (
    <WorkspacePage title={null}>
      {(workspace) => (
        <NewEntryPage
          workspace={workspace}
          workspaceParam={workspaceParam}
          kind={kind}
          supersedes={supersedes}
        />
      )}
    </WorkspacePage>
  );
}
