import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { FileRouteTypes } from "@/routeTree.gen";

type RoutePath = FileRouteTypes["to"];

/** Pages of the open workspace with no other path parameters, such as `/w/$workspace/calendar`. */
export type WorkspaceNavPath = Exclude<
  Extract<RoutePath, "/w/$workspace" | `/w/$workspace/${string}`>,
  `/w/$workspace/${string}$${string}`
>;

/**
 * Pages a sidebar item can open: any route without path parameters, or a page of the open
 * workspace, whose `$workspace` the menu fills in.
 */
export type NavPath = Exclude<RoutePath, `${string}$${string}`> | WorkspaceNavPath;

/**
 * `main` is the workspace's own pages under the switcher, `studio` its production tools, and
 * `footer` sits above the user menu.
 */
export type NavSection = "main" | "studio" | "footer";

/** What a badge sees: the workspace the sidebar works in. */
export interface NavBadgeProps {
  workspaceId: string;
}

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
  badge?: ComponentType<NavBadgeProps>;
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

/** Whether `path` opens a page of the open workspace. */
export function isWorkspacePath(path: NavPath): path is WorkspaceNavPath {
  return path === "/w/$workspace" || path.startsWith("/w/$workspace/");
}

/** The address of `path` in the workspace `param` (a slug or id). */
export function navHref(path: NavPath, param: string | null): string {
  return param === null ? path : path.replace("$workspace", param);
}
