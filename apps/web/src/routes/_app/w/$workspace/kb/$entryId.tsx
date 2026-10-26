import { IdSchema } from "@loomcast/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { KbEntryCrumb } from "@/features/kb/KbEntryCrumb";
import { KbEntryPage } from "@/features/kb/KbEntryPage";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/kb/$entryId")({
  staticData: { breadcrumb: (params) => <KbEntryCrumb id={params.entryId ?? ""} /> },
  component: EntryRoute,
});

function EntryRoute() {
  const { workspace: workspaceParam, entryId } = Route.useParams();
  return (
    <WorkspacePage title={null}>
      {(workspace) => (
        <KbEntryPage
          key={entryId}
          workspace={workspace}
          workspaceParam={workspaceParam}
          entryId={IdSchema.safeParse(entryId).success ? entryId : null}
        />
      )}
    </WorkspacePage>
  );
}
