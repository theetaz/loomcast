import { createFileRoute } from "@tanstack/react-router";
import { Page, PageHeader } from "@/components/PageHeader";
import { AnalyticsOverview } from "@/features/analytics/AnalyticsOverview";
import { DEFAULT_OVERVIEW_RANGE, OverviewSearchSchema } from "@/features/analytics/range";
import { useTitle } from "@/lib/use-title";

export const Route = createFileRoute("/_app/analytics/")({
  validateSearch: OverviewSearchSchema,
  component: AnalyticsPage,
});

function AnalyticsPage() {
  useTitle("Analytics");
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <Page className="max-w-[1240px]">
      <PageHeader
        title="Analytics"
        description="How published videos perform, from the platforms' own insights."
      />
      <AnalyticsOverview
        range={search.range ?? DEFAULT_OVERVIEW_RANGE}
        projectId={search.project ?? null}
        onRangeChange={(range) =>
          void navigate({
            search: (previous) => ({
              ...previous,
              range: range === DEFAULT_OVERVIEW_RANGE ? undefined : range,
            }),
            replace: true,
          })
        }
        onProjectChange={(project) =>
          void navigate({
            search: (previous) => ({ ...previous, project: project ?? undefined }),
            replace: true,
          })
        }
      />
    </Page>
  );
}
