import { createFileRoute } from "@tanstack/react-router";
import { DevicesSettings } from "@/features/settings/DevicesSettings";
import { useTitle } from "@/lib/use-title";

export const Route = createFileRoute("/_app/settings/devices")({
  staticData: { breadcrumb: "Devices" },
  component: DevicesPage,
});

function DevicesPage() {
  useTitle("Devices");
  return <DevicesSettings />;
}
