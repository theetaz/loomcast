import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useProject } from "./queries";

// Its own module: route breadcrumbs load with the app, so they must not pull in the project page.
export function ProjectCrumb({ idOrSlug }: { idOrSlug: string }) {
  const query = useProject(idOrSlug);
  if (query.data) return <>{query.data.name}</>;
  if (query.isPending)
    return <Skeleton aria-hidden="true" className="inline-block h-3 w-28 align-middle" />;
  return <>Project</>;
}
