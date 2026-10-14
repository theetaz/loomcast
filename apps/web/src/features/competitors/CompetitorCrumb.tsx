import { IdSchema } from "@loomcast/contracts";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { competitorQueryOptions } from "./queries";
import { competitorName } from "./status";

// Its own module: route breadcrumbs load with the app, so they must not pull in the pages.
export function CompetitorCrumb({ id }: { id: string }) {
  const valid = IdSchema.safeParse(id).success;
  const query = useQuery({ ...competitorQueryOptions(id), enabled: valid });
  if (query.data) return <>{competitorName(query.data)}</>;
  if (valid && query.isPending) {
    return <Skeleton aria-hidden="true" className="inline-block h-3 w-28 align-middle" />;
  }
  return <>Competitor</>;
}
