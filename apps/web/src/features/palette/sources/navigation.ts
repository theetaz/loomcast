import { CompassIcon, FolderIcon, HouseIcon } from "lucide-react";
import { visibleSettingsItems } from "@/features/settings-nav/registry";
import { rankByMatch } from "../match";
import type { PaletteItem, PaletteSource } from "../types";

/** Static pages: the app's top level and every settings section the user may open. */
export const source: PaletteSource = {
  id: "navigation",
  heading: "Go to",
  order: 40,
  icon: CompassIcon,
  useItems: ({ query, me }) => {
    const items: (PaletteItem & { keywords?: readonly string[] })[] = [
      { id: "nav:/", label: "Home", icon: HouseIcon, href: "/", keywords: ["dashboard", "start"] },
      {
        id: "nav:/projects",
        label: "Projects",
        icon: FolderIcon,
        href: "/projects",
        keywords: ["all projects", "list"],
      },
      ...visibleSettingsItems(me).map((item) => ({
        id: `nav:${item.to}`,
        label: item.label,
        icon: item.icon,
        href: item.to,
        secondary: item.description,
        meta: "Settings",
        recentDetail: "Settings",
        keywords: ["settings", ...(item.keywords ?? [])],
      })),
    ];
    return rankByMatch(items, query, (item) => ({ label: item.label, keywords: item.keywords }));
  },
};
