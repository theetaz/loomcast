import type { Me } from "@loomcast/contracts";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** What every source sees while the palette is open. */
export interface PaletteContext {
  /** The search text, trimmed. Empty until the user types. */
  query: string;
  me: Me;
  /** The `projectId` route parameter (an id or a slug) when a project page is open. */
  projectParam: string | null;
  /** Closes the palette and opens the new project dialog. */
  openNewProject: () => void;
}

/** One row of the palette. */
export interface PaletteItem {
  /** Unique across every source; cmdk uses it as the row's value. */
  id: string;
  label: string;
  icon: LucideIcon;
  /** Extra classes for the icon, such as a kind colour. */
  iconClassName?: string;
  /** A second line under the label. */
  secondary?: ReactNode;
  /** Short trailing text, such as the project of a search hit. */
  meta?: ReactNode;
  /**
   * An in-app path to open. Items with one are remembered in Recent, using
   * `recentDetail` as their plain-text second line.
   */
  href?: string;
  recentDetail?: string;
  /** Runs instead of opening `href`. The palette closes first. */
  run?: () => void;
  /** Shown but not selectable, for status rows such as "Searching…". */
  disabled?: boolean;
}

/**
 * A group of palette rows. Each file in `./sources` exports one as `source`,
 * so a feature adds palette results by adding a file.
 */
export interface PaletteSource {
  id: string;
  heading: string;
  /** Groups sort by `order`, lowest first. */
  order: number;
  /** Shown for this source's items in Recent. */
  icon: LucideIcon;
  /**
   * Called as a hook while the palette is open. It filters and ranks its own
   * rows for `context.query`; the palette does not filter again.
   */
  useItems: (context: PaletteContext) => PaletteItem[] | PaletteSourceResult;
}

export interface PaletteSourceResult {
  items: PaletteItem[];
  /** Shown at the end of the group heading, such as "Searching…". */
  status?: ReactNode;
}
