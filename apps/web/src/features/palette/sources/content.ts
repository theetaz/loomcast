import { statusStyle } from "@loomcast/ui/components/StatusPill";
import { useQuery } from "@tanstack/react-query";
import { ClapperboardIcon, TriangleAlertIcon } from "lucide-react";
import { useContentSearch } from "@/features/library/use-content-search";
import { workspacesQueryOptions } from "@/features/workspaces/queries";
import { errorMessage } from "@/lib/api";
import type { PaletteItem, PaletteSource } from "../types";

/**
 * Videos whose title or pitch matches, searched on the server as the user types: the open
 * workspace's only, or every workspace's outside one.
 */
export const source: PaletteSource = {
  id: "content",
  heading: "Videos",
  order: 15,
  icon: ClapperboardIcon,
  useItems: ({ query, workspace: current }) => {
    const search = useContentSearch(query, current?.id ?? null);
    const { data: workspaces = [] } = useQuery(workspacesQueryOptions());
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));

    const items: PaletteItem[] = search.items.map((item) => {
      const state = statusStyle("pipeline", item.state).label;
      const workspace = byId.get(item.workspaceId);
      return {
        id: `content:${item.id}`,
        label: item.title,
        icon: ClapperboardIcon,
        secondary: current ? undefined : workspace?.name,
        meta: state,
        href: `/w/${workspace?.slug ?? item.workspaceId}/content/${item.id}`,
        recentDetail: workspace ? `${state} in ${workspace.name}` : state,
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
