import { IdSchema } from "@loomcast/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceCrumb } from "@/features/workspace/WorkspaceCrumb";
import { WorkspaceLayout } from "@/features/workspace/WorkspaceLayout";

/**
 * `?conversation=<id>` opens that conversation in Chat; anything else is dropped. It is declared
 * here, on the layout, because the conversation panel reads it from this route.
 */
interface WorkspaceSearch {
  conversation?: string;
}

/** One workspace, by slug or id; every page below it shows only this workspace's data. */
export const Route = createFileRoute("/_app/w/$workspace")({
  validateSearch: (search: Record<string, unknown>): WorkspaceSearch => {
    const conversation = IdSchema.safeParse(search.conversation);
    return conversation.success ? { conversation: conversation.data } : {};
  },
  staticData: { breadcrumb: (params) => <WorkspaceCrumb idOrSlug={params.workspace ?? ""} /> },
  component: WorkspaceRoute,
});

function WorkspaceRoute() {
  const { workspace } = Route.useParams();
  return <WorkspaceLayout param={workspace} />;
}
