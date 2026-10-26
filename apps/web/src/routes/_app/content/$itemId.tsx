import { createFileRoute } from "@tanstack/react-router";
import { contentItemQueryOptions } from "@/features/library/queries";
import { redirectIntoWorkspace } from "@/features/workspace/legacy";

/** Moved into the item's workspace: `/w/<workspace>/content/<id>`, keeping the tab. */
export const Route = createFileRoute("/_app/content/$itemId")({
  beforeLoad: async ({ context, location, params }) => {
    const detail = await context.queryClient
      .ensureQueryData(contentItemQueryOptions(params.itemId))
      .catch(() => null);
    return redirectIntoWorkspace(
      context.queryClient,
      location,
      `/content/${params.itemId}`,
      detail?.item.workspaceId,
    );
  },
});
