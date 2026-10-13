import { createFileRoute } from "@tanstack/react-router";
import { ChannelsSettings } from "@/features/channels/ChannelsSettings";
import { useTitle } from "@/lib/use-title";

// An index route, so the connect page can live beside it at `/settings/channels/connect`.
export const Route = createFileRoute("/_app/settings/channels/")({
  staticData: { breadcrumb: "Channels" },
  component: ChannelsPage,
});

function ChannelsPage() {
  useTitle("Channels");
  return <ChannelsSettings />;
}
