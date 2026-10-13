import { createFileRoute } from "@tanstack/react-router";
import { TokensSettings } from "@/features/settings/TokensSettings";
import { useTitle } from "@/lib/use-title";

export const Route = createFileRoute("/_app/settings/tokens")({
  staticData: { breadcrumb: "Access tokens" },
  component: TokensPage,
});

function TokensPage() {
  useTitle("Access tokens");
  return <TokensSettings />;
}
