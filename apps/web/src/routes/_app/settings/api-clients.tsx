import { createFileRoute } from "@tanstack/react-router";
import { ApiClientsSettings } from "@/features/api-clients/ApiClientsSettings";
import { useTitle } from "@/lib/use-title";

export const Route = createFileRoute("/_app/settings/api-clients")({
  staticData: { breadcrumb: "API clients" },
  component: ApiClientsPage,
});

function ApiClientsPage() {
  useTitle("API clients");
  return <ApiClientsSettings />;
}
