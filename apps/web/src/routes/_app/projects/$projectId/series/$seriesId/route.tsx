import { IdSchema } from "@loomcast/contracts";
import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { SeriesCrumb } from "@/features/series/SeriesCrumb";

/** One series and its format page; the crumb names the series. */
export const Route = createFileRoute("/_app/projects/$projectId/series/$seriesId")({
  beforeLoad: ({ params }) => {
    if (!IdSchema.safeParse(params.seriesId).success) throw notFound();
  },
  staticData: { breadcrumb: (params) => <SeriesCrumb id={params.seriesId ?? ""} /> },
  component: Outlet,
});
