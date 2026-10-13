import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { FileRouteTypes } from "@/routeTree.gen";

/** Pages a sidebar item can open: any route without path parameters. */
export type NavPath = Exclude<FileRouteTypes["to"], `${string}$${string}`>;

/** `main` is the list under the logo; `footer` sits above the user menu. */
export type NavSection = "main" | "footer";

/**
 * One sidebar item. Each file in `./items` exports one as `item`, so a feature adds itself to the
 * sidebar by adding a file instead of editing a shared list.
 */
export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Items sort by `order` within their section, lowest first. */
  order: number;
  /** Defaults to `main`. */
  section?: NavSection;
  /**
   * The page it opens. An item without one is shown disabled with a "Soon" badge, for screens that
   * are planned but not built yet.
   */
  to?: NavPath;
  /** Active only on `to` itself, not on the pages below it. */
  exact?: boolean;
  /** Rendered at the end of the row, such as a count. Renders nothing when there is nothing to say. */
  badge?: ComponentType;
}

const modules = import.meta.glob<{ item: NavItem }>("./items/*.ts", { eager: true });

function byOrder(a: NavItem, b: NavItem): number {
  return a.order - b.order || a.id.localeCompare(b.id);
}

/** Every sidebar item, in display order. */
export const navItems: readonly NavItem[] = Object.values(modules)
  .map((module) => module.item)
  .sort(byOrder);

/** The items of one section, in display order. */
export function navSection(items: readonly NavItem[], section: NavSection): NavItem[] {
  return items.filter((item) => (item.section ?? "main") === section).sort(byOrder);
}
