import { createFileRoute } from "@tanstack/react-router";
import { LaptopIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { useTitle } from "@/lib/use-title";

export const Route = createFileRoute("/_app/settings/devices")({
  staticData: { breadcrumb: "Devices" },
  component: DevicesSettings,
});

/** Placeholder until device pairing and management land. */
function DevicesSettings() {
  useTitle("Devices");
  return (
    <div className="rounded-lg bg-card shadow-card">
      <EmptyState
        icon={LaptopIcon}
        title="Pair a studio agent"
        description="Studio agents run on your own machine and render the videos. Pairing arrives here soon."
      />
    </div>
  );
}
