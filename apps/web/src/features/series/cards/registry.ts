import type { Format, Project, Series } from "@loomcast/contracts";
import type { ComponentType } from "react";

/** What every card on the series page receives. */
export interface SeriesCardProps {
  series: Series;
  project: Project;
  /** The series' format, once loaded. */
  format: Format | undefined;
  /** The project as it appears in the address (id or slug), for links. */
  projectParam: string;
}

/**
 * One card in the side column of the series page. Each file in `./items` exports one as `card`,
 * so a feature adds a card (the cadence, the format, the series' channels) by adding a file
 * instead of editing the page.
 */
export interface SeriesCard {
  id: string;
  /** Cards sort by `order`, lowest first: cadence 10, format 20; channels fits at 30. */
  order: number;
  Card: ComponentType<SeriesCardProps>;
}

const modules = import.meta.glob<{ card: SeriesCard }>("./items/*.tsx", { eager: true });

/** Every series card, in display order. */
export const seriesCards: readonly SeriesCard[] = Object.values(modules)
  .map((module) => module.card)
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
