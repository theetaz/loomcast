import { createFileRoute } from "@tanstack/react-router";
import { seriesQueryOptions } from "@/features/series/queries";
import { redirectIntoWorkspace } from "@/features/workspace/legacy";

/** Moved into the series' workspace: `/w/<workspace>/analytics/series/<id>`. */
export const Route = createFileRoute("/_app/analytics/series/$seriesId")({
  beforeLoad: async ({ context, location, params }) => {
    const series = await context.queryClient
      .ensureQueryData(seriesQueryOptions(params.seriesId))
      .catch(() => null);
    return redirectIntoWorkspace(
      context.queryClient,
      location,
      `/analytics/series/${params.seriesId}`,
      series?.workspaceId,
    );
  },
});
