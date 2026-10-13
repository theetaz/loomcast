import { OAuthConnectSearchSchema } from "@loomcast/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { ConnectPage } from "@/features/channels/connect/ConnectPage";
import { useTitle } from "@/lib/use-title";

/**
 * Where a sign-in comes back to (`OAUTH_CONNECT_PAGE_PATH`). A value the page can't use is dropped
 * rather than failing the page: the URL comes from the server's redirect, not a link.
 */
const ConnectSearchSchema = OAuthConnectSearchSchema.extend({
  connection: OAuthConnectSearchSchema.shape.connection.catch(undefined),
  provider: OAuthConnectSearchSchema.shape.provider.catch(undefined),
  error: OAuthConnectSearchSchema.shape.error.catch(undefined),
});

export const Route = createFileRoute("/_app/settings/channels/connect")({
  validateSearch: ConnectSearchSchema,
  staticData: { breadcrumb: "Connect channels" },
  component: ConnectRoute,
});

function ConnectRoute() {
  useTitle("Connect channels");
  return <ConnectPage search={Route.useSearch()} />;
}
