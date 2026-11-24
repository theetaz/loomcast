import type { ContentItemDetail } from "@loomcast/contracts";
import { useQuery } from "@tanstack/react-query";
import { ProgressDetail } from "@/features/production/ProgressSteps";
import { progressItemQueryOptions, useProgressLive } from "@/features/production/queries";
import type { ItemCard } from "../registry";

/** The item's production steps, when a producer outside Loomcast reported them. */
function ProductionCard({ detail }: { detail: ContentItemDetail }) {
  useProgressLive();
  const progress = useQuery(progressItemQueryOptions(detail.item.id));
  if (!progress.data) return null;
  return (
    <section
      aria-labelledby="item-production-title"
      className="flex flex-col gap-2 rounded-lg bg-card p-4 shadow-card"
    >
      <h2 id="item-production-title" className="text-heading text-foreground">
        Production
      </h2>
      <ProgressDetail progress={progress.data} />
    </section>
  );
}

export const card: ItemCard = {
  id: "production",
  placement: "rail",
  order: 5,
  component: ProductionCard,
};
