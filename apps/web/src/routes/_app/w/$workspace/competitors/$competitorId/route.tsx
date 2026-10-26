import { IdSchema } from "@loomcast/contracts";
import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { CompetitorCrumb } from "@/features/competitors/CompetitorCrumb";

/** One competitor and its scans; the crumb names the competitor. */
export const Route = createFileRoute("/_app/w/$workspace/competitors/$competitorId")({
  beforeLoad: ({ params }) => {
    if (!IdSchema.safeParse(params.competitorId).success) throw notFound();
  },
  staticData: { breadcrumb: (params) => <CompetitorCrumb id={params.competitorId ?? ""} /> },
  component: Outlet,
});
