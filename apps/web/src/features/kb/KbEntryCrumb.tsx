import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { kbEntryQueryOptions } from "./queries";

// Its own module: route breadcrumbs load with the app, so they must not pull in the entry page.
export function KbEntryCrumb({ id }: { id: string }) {
  const query = useQuery({ ...kbEntryQueryOptions(id), enabled: id !== "" });
  if (query.data) return <>{query.data.title}</>;
  if (query.isPending)
    return <Skeleton aria-hidden="true" className="inline-block h-3 w-28 align-middle" />;
  return <>Entry</>;
}
