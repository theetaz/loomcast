import { useQuery } from "@tanstack/react-query";
import { LibraryIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { KIND_META } from "@/features/kb/kinds";
import { projectsQueryOptions } from "@/features/projects/queries";
import { errorMessage } from "@/lib/api";
import { Snippet } from "@/lib/snippet";
import type { PaletteItem, PaletteSource } from "../types";
import { useKbSearch } from "../use-kb-search";

/** Knowledge-base entries of every project, searched on the server as the user types. */
export const source: PaletteSource = {
  id: "kb",
  heading: "Knowledge base",
  order: 20,
  icon: LibraryIcon,
  useItems: ({ query }) => {
    const search = useKbSearch(query);
    const { data: projects = [] } = useQuery(projectsQueryOptions());
    const byId = new Map(projects.map((project) => [project.id, project]));

    const items: PaletteItem[] = search.hits.map((hit) => {
      const kind = KIND_META[hit.kind];
      const project = byId.get(hit.projectId);
      const projectParam = project?.slug ?? hit.projectId;
      return {
        id: `kb:${hit.entryId}`,
        label: hit.title,
        icon: kind.icon,
        iconClassName: kind.tone,
        secondary: hit.snippet ? <Snippet text={hit.snippet} /> : undefined,
        meta: project?.name,
        href: `/projects/${projectParam}/kb/${hit.entryId}`,
        recentDetail: project ? `${kind.label} in ${project.name}` : kind.label,
      };
    });

    if (search.status === "pending" && items.length === 0) {
      items.push({
        id: "kb:status:pending",
        label: "Searching the knowledge base…",
        icon: LoaderCircleIcon,
        iconClassName: "animate-spin motion-reduce:animate-none",
        disabled: true,
      });
    }
    if (search.status === "error") {
      items.push({
        id: "kb:status:error",
        label: "Couldn't search the knowledge base",
        icon: TriangleAlertIcon,
        iconClassName: "text-status-red",
        secondary: errorMessage(search.error),
        disabled: true,
      });
    }

    return {
      items,
      status:
        search.status === "pending" && search.hits.length > 0 ? (
          <span role="status">Searching…</span>
        ) : undefined,
    };
  },
};
