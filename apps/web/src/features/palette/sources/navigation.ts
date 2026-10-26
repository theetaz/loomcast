import { CompassIcon, FolderIcon } from "lucide-react";
import { isWorkspacePath, navHref, navItems } from "@/app/nav/registry";
import { visibleSettingsItems } from "@/features/settings-nav/registry";
import { rankByMatch } from "../match";
import type { PaletteItem, PaletteSource } from "../types";

/**
 * Static pages: the open workspace's pages, the workspace list and every account settings section
 * the user may open.
 */
export const source: PaletteSource = {
  id: "navigation",
  heading: "Go to",
  order: 40,
  icon: CompassIcon,
  useItems: ({ query, me, workspace }) => {
    const pages: (PaletteItem & { keywords?: readonly string[] })[] = workspace
      ? navItems.flatMap((item) =>
          item.to && isWorkspacePath(item.to)
            ? [
                {
                  id: `nav:${item.to}`,
                  label: item.label,
                  icon: item.icon,
                  href: navHref(item.to, workspace.slug),
                  meta: workspace.name,
                  recentDetail: workspace.name,
                },
              ]
            : [],
        )
      : [];
    const items: (PaletteItem & { keywords?: readonly string[] })[] = [
      ...pages,
      {
        id: "nav:/workspaces",
        label: "All workspaces",
        icon: FolderIcon,
        href: "/workspaces",
        keywords: ["workspaces", "list", "switch"],
      },
      ...visibleSettingsItems(me).map((item) => ({
        id: `nav:${item.to}`,
        label: item.label,
        icon: item.icon,
        href: item.to,
        secondary: item.description,
        meta: "Account settings",
        recentDetail: "Account settings",
        keywords: ["settings", "account", ...(item.keywords ?? [])],
      })),
    ];
    return rankByMatch(items, query, (item) => ({ label: item.label, keywords: item.keywords }));
  },
};
