import { createFileRoute } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { useTitle } from "@/lib/use-title";

export const Route = createFileRoute("/_app/settings/tokens")({
  staticData: { breadcrumb: "Access tokens" },
  component: TokensSettings,
});

/** Placeholder until access token management lands. */
function TokensSettings() {
  useTitle("Access tokens");
  return (
    <div className="rounded-lg bg-card shadow-card">
      <EmptyState
        icon={KeyRoundIcon}
        title="Connect other tools"
        description="Access tokens let local tools create and read projects over MCP. Managing them arrives here soon."
      />
    </div>
  );
}
