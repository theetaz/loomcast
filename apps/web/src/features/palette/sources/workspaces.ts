import { useQuery } from "@tanstack/react-query";
import { ArchiveIcon, FolderIcon } from "lucide-react";
import { workspacesQueryOptions } from "@/features/workspaces/queries";
import { rankByMatch } from "../match";
import type { PaletteSource } from "../types";

/** Workspaces shown before the user types: the most recently updated. */
const IDLE_LIMIT = 5;
const MATCH_LIMIT = 8;

/** Workspaces to switch to, from the cached list (loaded once if nothing has asked for it yet). */
export const source: PaletteSource = {
  id: "workspaces",
  heading: "Switch workspace",
  order: 10,
  icon: FolderIcon,
  useItems: ({ query, workspace: current }) => {
    const { data: workspaces = [] } = useQuery(workspacesQueryOptions());
    // Active workspaces first; archived ones stay findable by name.
    const ordered = [
      ...workspaces.filter((workspace) => workspace.status !== "archived"),
      ...workspaces.filter((workspace) => workspace.status === "archived"),
    ];
    const matches = query
      ? rankByMatch(
          ordered,
          query,
          (workspace) => ({ label: workspace.name, keywords: [workspace.slug] }),
          MATCH_LIMIT,
        )
      : ordered.filter((workspace) => workspace.status !== "archived").slice(0, IDLE_LIMIT);
    return matches.map((workspace) => {
      const archived = workspace.status === "archived";
      return {
        id: `workspace:${workspace.id}`,
        label: workspace.name,
        icon: archived ? ArchiveIcon : FolderIcon,
        meta: archived ? "Archived" : workspace.id === current?.id ? "Current" : workspace.slug,
        href: `/w/${workspace.slug}`,
        recentDetail: archived ? "Archived" : workspace.slug,
      };
    });
  },
};
