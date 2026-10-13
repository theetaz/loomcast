import { useQuery } from "@tanstack/react-query";
import { ArchiveIcon, FolderIcon } from "lucide-react";
import { projectsQueryOptions } from "@/features/projects/queries";
import { rankByMatch } from "../match";
import type { PaletteSource } from "../types";

/** Projects shown before the user types: the most recently updated. */
const IDLE_LIMIT = 5;
const MATCH_LIMIT = 8;

/** Projects from the cached list (loaded once if nothing has asked for it yet). */
export const source: PaletteSource = {
  id: "projects",
  heading: "Projects",
  order: 10,
  icon: FolderIcon,
  useItems: ({ query }) => {
    const { data: projects = [] } = useQuery(projectsQueryOptions());
    // Active projects first; archived ones stay findable by name.
    const ordered = [
      ...projects.filter((project) => project.status !== "archived"),
      ...projects.filter((project) => project.status === "archived"),
    ];
    const matches = query
      ? rankByMatch(
          ordered,
          query,
          (project) => ({ label: project.name, keywords: [project.slug] }),
          MATCH_LIMIT,
        )
      : ordered.filter((project) => project.status !== "archived").slice(0, IDLE_LIMIT);
    return matches.map((project) => {
      const archived = project.status === "archived";
      return {
        id: `project:${project.id}`,
        label: project.name,
        icon: archived ? ArchiveIcon : FolderIcon,
        meta: archived ? "Archived" : project.slug,
        href: `/projects/${project.slug}`,
        recentDetail: archived ? "Archived" : project.slug,
      };
    });
  },
};
