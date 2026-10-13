import { IdSchema } from "@loomcast/contracts";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { seriesQueryOptions } from "./queries";

// Its own module: route breadcrumbs load with the app, so they must not pull in the series pages.
export function SeriesCrumb({ id }: { id: string }) {
  const valid = IdSchema.safeParse(id).success;
  const query = useQuery({ ...seriesQueryOptions(id), enabled: valid });
  if (query.data) return <>{query.data.name}</>;
  if (valid && query.isPending) {
    return <Skeleton aria-hidden="true" className="inline-block h-3 w-28 align-middle" />;
  }
  return <>Series</>;
}
