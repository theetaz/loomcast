import { useQuery } from "@tanstack/react-query";
import { LibraryIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { KIND_META } from "@/features/kb/kinds";
import { workspacesQueryOptions } from "@/features/workspaces/queries";
import { errorMessage } from "@/lib/api";
import { Snippet } from "@/lib/snippet";
import type { PaletteItem, PaletteSource } from "../types";
import { useKbSearch } from "../use-kb-search";

/**
 * Knowledge-base entries, searched on the server as the user types: the open workspace's only, or
 * every workspace's outside one.
 */
export const source: PaletteSource = {
  id: "kb",
  heading: "Knowledge base",
  order: 20,
  icon: LibraryIcon,
  useItems: ({ query, workspace: current }) => {
    const search = useKbSearch(query, current?.id ?? null);
    const { data: workspaces = [] } = useQuery(workspacesQueryOptions());
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));

    const items: PaletteItem[] = search.hits.map((hit) => {
      const kind = KIND_META[hit.kind];
      const workspace = byId.get(hit.workspaceId);
      const workspaceParam = workspace?.slug ?? hit.workspaceId;
      return {
        id: `kb:${hit.entryId}`,
        label: hit.title,
        icon: kind.icon,
        iconClassName: kind.tone,
        secondary: hit.snippet ? <Snippet text={hit.snippet} /> : undefined,
        meta: current ? undefined : workspace?.name,
        href: `/w/${workspaceParam}/kb/${hit.entryId}`,
        recentDetail: workspace ? `${kind.label} in ${workspace.name}` : kind.label,
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
