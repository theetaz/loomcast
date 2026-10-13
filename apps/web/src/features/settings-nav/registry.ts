import type { Me } from "@loomcast/contracts";
import type { LucideIcon } from "lucide-react";
import type { FileRouteTypes } from "@/routeTree.gen";

/** Pages a settings section can open. */
export type SettingsPath = Extract<FileRouteTypes["to"], `/settings/${string}`>;

/**
 * One section of Settings. Each file in `./items` exports one as `item`, so a
 * feature adds a section by adding a file instead of editing a shared list.
 */
export interface SettingsNavItem {
  id: string;
  label: string;
  /** One line about the section, shown in the command palette. */
  description: string;
  icon: LucideIcon;
  to: SettingsPath;
  /** Sections sort by `order`, lowest first. */
  order: number;
  /** Extra words the command palette matches. */
  keywords?: readonly string[];
  /** Hides the section from users who can't use it. Shown to everyone when absent. */
  visible?: (me: Me) => boolean;
}

const modules = import.meta.glob<{ item: SettingsNavItem }>("./items/*.ts", { eager: true });

/** Every settings section, in display order. */
export const settingsNavItems: readonly SettingsNavItem[] = Object.values(modules)
  .map((module) => module.item)
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

/** The sections `me` may open, in display order. */
export function visibleSettingsItems(
  me: Me,
  items: readonly SettingsNavItem[] = settingsNavItems,
): SettingsNavItem[] {
  return items.filter((item) => item.visible?.(me) ?? true);
}
