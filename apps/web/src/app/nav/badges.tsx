import { SidebarMenuBadge } from "@loomcast/ui/components/sidebar";
import { useQuery } from "@tanstack/react-query";
import { projectsQueryOptions } from "@/features/projects/queries";

/** The number of active projects, next to Projects. */
export function ActiveProjectCount() {
  const { data } = useQuery(projectsQueryOptions());
  const active = data?.filter((project) => project.status === "active").length;
  if (!active) return null;
  return (
    <SidebarMenuBadge className="top-1">
      <span className="sr-only">, </span>
      {active}
      <span className="sr-only"> active</span>
    </SidebarMenuBadge>
  );
}
