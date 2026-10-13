import { statusStyle } from "@loomcast/ui/components/StatusPill";
import { useQuery } from "@tanstack/react-query";
import { ClapperboardIcon, TriangleAlertIcon } from "lucide-react";
import { useContentSearch } from "@/features/library/use-content-search";
import { projectsQueryOptions } from "@/features/projects/queries";
import { errorMessage } from "@/lib/api";
import type { PaletteItem, PaletteSource } from "../types";

/** Videos of every project whose title or pitch matches, searched on the server as the user types. */
export const source: PaletteSource = {
  id: "content",
  heading: "Videos",
  order: 15,
  icon: ClapperboardIcon,
  useItems: ({ query }) => {
    const search = useContentSearch(query);
    const { data: projects = [] } = useQuery(projectsQueryOptions());
    const byId = new Map(projects.map((project) => [project.id, project]));

    const items: PaletteItem[] = search.items.map((item) => {
      const state = statusStyle("pipeline", item.state).label;
      const project = byId.get(item.projectId);
      return {
        id: `content:${item.id}`,
        label: item.title,
        icon: ClapperboardIcon,
        secondary: project?.name,
        meta: state,
        href: `/content/${item.id}`,
        recentDetail: project ? `${state} in ${project.name}` : state,
      };
    });

    if (search.status === "error") {
      items.push({
        id: "content:status:error",
        label: "Couldn't search videos",
        icon: TriangleAlertIcon,
        iconClassName: "text-status-red",
        secondary: errorMessage(search.error),
        disabled: true,
      });
    }

    return { items };
  },
};
