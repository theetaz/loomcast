import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { AnalyticsOverview } from "@/features/analytics/AnalyticsOverview";
import { DEFAULT_OVERVIEW_RANGE, OverviewSearchSchema } from "@/features/analytics/range";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/analytics/")({
  validateSearch: OverviewSearchSchema,
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <WorkspacePage title="Analytics" className="max-w-[1240px]">
      {(workspace) => (
        <>
          <PageHeader
            title="Analytics"
            description="How published videos perform, from the platforms' own insights."
          />
          <AnalyticsOverview
            key={workspace.id}
            range={search.range ?? DEFAULT_OVERVIEW_RANGE}
            workspaceId={workspace.id}
            onRangeChange={(range) =>
              void navigate({
                search: { range: range === DEFAULT_OVERVIEW_RANGE ? undefined : range },
                replace: true,
              })
            }
          />
        </>
      )}
    </WorkspacePage>
  );
}
