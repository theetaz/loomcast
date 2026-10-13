import type { ContentItemDetail } from "@loomcast/contracts";
import type { ComponentType } from "react";

/** Where a card sits: under the tabs, or in the right rail above the versions. */
export type ItemCardPlacement = "main" | "rail";

/**
 * An extra card on the item page, such as analytics. Each file in `./items` exports one as
 * `card`, so a feature adds a card by adding a file instead of editing the page. Cards render
 * nothing when they have nothing to say.
 */
export interface ItemCard {
  id: string;
  placement: ItemCardPlacement;
  /** Cards sort by `order` within their placement, lowest first. */
  order: number;
  component: ComponentType<{ detail: ContentItemDetail }>;
}

const modules = import.meta.glob<{ card: ItemCard }>("./items/*.tsx", { eager: true });

/** Every card of one placement, in display order. */
export function itemCards(placement: ItemCardPlacement): ItemCard[] {
  return Object.values(modules)
    .map((module) => module.card)
    .filter((card) => card.placement === placement)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
