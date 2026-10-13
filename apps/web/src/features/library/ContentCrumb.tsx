import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { contentItemQueryOptions } from "./queries";

/** The item's title in the breadcrumbs. */
export function ContentCrumb({ itemId }: { itemId: string }) {
  const { data } = useQuery(contentItemQueryOptions(itemId));
  if (data) return <>{data.item.title}</>;
  return <Skeleton aria-hidden="true" className="inline-block h-3 w-28 align-middle" />;
}
