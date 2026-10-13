import { IdSchema } from "@loomcast/contracts";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { DEFAULT_SERIES_RANGE, SeriesSearchSchema } from "@/features/analytics/range";
import { SeriesAnalyticsPage } from "@/features/analytics/SeriesAnalytics";
import { SeriesCrumb } from "@/features/series/SeriesCrumb";

export const Route = createFileRoute("/_app/analytics/series/$seriesId")({
  beforeLoad: ({ params }) => {
    if (!IdSchema.safeParse(params.seriesId).success) throw notFound();
  },
  validateSearch: SeriesSearchSchema,
  staticData: { breadcrumb: (params) => <SeriesCrumb id={params.seriesId ?? ""} /> },
  component: SeriesAnalyticsRoute,
});

function SeriesAnalyticsRoute() {
  const { seriesId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SeriesAnalyticsPage
      key={seriesId}
      seriesId={seriesId}
      range={search.range ?? DEFAULT_SERIES_RANGE}
      onRangeChange={(range) =>
        void navigate({
          search: { range: range === DEFAULT_SERIES_RANGE ? undefined : range },
          replace: true,
        })
      }
    />
  );
}
