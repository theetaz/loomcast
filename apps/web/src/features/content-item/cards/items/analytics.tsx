import type { ContentItemDetail, PipelineState } from "@loomcast/contracts";
import { lazy, Suspense } from "react";
import type { ItemCard } from "../registry";

// The charts and their scales load with the card, not with the item page.
const ItemAnalyticsCard = lazy(() => import("@/features/analytics/ItemAnalyticsCard"));

/** States an item can have live posts in: published, or scheduled again for more channels. */
const MEASURED_STATES = new Set<PipelineState>(["scheduled", "published", "archived"]);

function AnalyticsSlot({ detail }: { detail: ContentItemDetail }) {
  if (!MEASURED_STATES.has(detail.item.state)) return null;
  return (
    <Suspense fallback={null}>
      <ItemAnalyticsCard detail={detail} />
    </Suspense>
  );
}

export const card: ItemCard = {
  id: "analytics",
  placement: "main",
  order: 10,
  component: AnalyticsSlot,
};
