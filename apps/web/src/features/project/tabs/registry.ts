import type { LucideIcon } from "lucide-react";
import type { FileRouteTypes } from "@/routeTree.gen";

/** Routes a project tab can open: the project page and the pages below it. */
export type ProjectTabPath = Extract<
  FileRouteTypes["to"],
  "/projects/$projectId" | `/projects/$projectId/${string}`
>;

/**
 * One tab of the project page. Each file in `./items` exports one as `tab`, so a feature adds a
 * tab by adding a file instead of editing a shared list.
 */
export interface ProjectTab {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Opened with the project's `projectId`; the tab stays active on every page below it. */
  to: ProjectTabPath;
  /** Tabs sort by `order`, lowest first. */
  order: number;
}

const modules = import.meta.glob<{ tab: ProjectTab }>("./items/*.tsx", { eager: true });

/** Every project tab, in display order. */
export const projectTabs: readonly ProjectTab[] = Object.values(modules)
  .map((module) => module.tab)
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

/**
 * The tab a location belongs to: the one whose path is the longest prefix of `pathname`. The
 * overview (the project root) is the fallback for anything else under the project.
 */
export function activeTabFor(
  tabs: readonly ProjectTab[],
  pathname: string,
  projectPath: string,
): ProjectTab | undefined {
  const path = pathname.replace(/\/+$/, "");
  let best: { tab: ProjectTab; length: number } | undefined;
  for (const tab of tabs) {
    const prefix = tab.to.replace("/projects/$projectId", projectPath).replace(/\/+$/, "");
    const matches = path === prefix || path.startsWith(`${prefix}/`);
    if (matches && (!best || prefix.length > best.length)) best = { tab, length: prefix.length };
  }
  return best?.tab;
}
