import type { AccessToken } from "@loomcast/contracts";
import { Badge } from "@loomcast/ui/components/badge";
import { Button } from "@loomcast/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { CreateTokenDialog } from "./CreateTokenDialog";
import { McpConfigSnippet } from "./McpConfigSnippet";
import { SCOPE_LABELS, tokensQueryOptions, useRevokeToken } from "./queries";
import { RevokeDialog } from "./RevokeDialog";
import { SettingsCard, TableSkeleton, td, th } from "./SettingsCard";

/** MCP access tokens: list, create with a one-time reveal, revoke, and a client config example. */
export function TokensSettings() {
  const query = useQuery(tokensQueryOptions());
  const revoke = useRevokeToken();
  // The target outlives `confirming` so the dialog keeps its title while it fades out.
  const [target, setTarget] = useState<AccessToken | null>(null);
  const [confirming, setConfirming] = useState(false);

  const confirmRevoke = () => {
    if (!target) return;
    revoke.mutate(target, {
      onSuccess: () => {
        setConfirming(false);
        toast.success("Token revoked", { description: target.name });
      },
    });
  };

  return (
    <div className="grid gap-4">
      <SettingsCard
        title="Access tokens"
        count={query.isSuccess ? query.data.length : null}
        busy={query.isPending}
        action={
          <CreateTokenDialog>
            <Button size="sm">
              <PlusIcon aria-hidden="true" />
              New token
            </Button>
          </CreateTokenDialog>
        }
      >
        {query.isPending ? (
          <TableSkeleton columns={["w-24", "w-20", "w-10", "w-10"]} />
        ) : query.isError ? (
          <ErrorState
            size="compact"
            title="Couldn't load access tokens"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : query.data.length === 0 ? (
          <EmptyState
            icon={KeyRoundIcon}
            title="No access tokens"
            description="Create a token for each tool that should create or read workspaces over MCP."
            action={
              <CreateTokenDialog>
                <Button>
                  <PlusIcon aria-hidden="true" />
                  New token
                </Button>
              </CreateTokenDialog>
            }
          />
        ) : (
          <table aria-label="Access tokens" className="w-full table-fixed text-left">
            <thead>
              <tr className="h-9 border-divider border-b">
                <th scope="col" className={th("pl-3.5")}>
                  Name
                </th>
                <th scope="col" className={th("hidden w-[19%] md:table-cell")}>
                  Token
                </th>
                <th scope="col" className={th("hidden w-[24%] sm:table-cell")}>
                  Scopes
                </th>
                <th scope="col" className={th("w-[76px] text-right sm:w-[84px]")}>
                  Last used
                </th>
                <th scope="col" className={th("hidden w-[76px] text-right md:table-cell")}>
                  Created
                </th>
                <th scope="col" className={th("w-11 pr-2")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((token) => (
                <TokenRow
                  key={token.id}
                  token={token}
                  onRevoke={() => {
                    revoke.reset();
                    setTarget(token);
                    setConfirming(true);
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </SettingsCard>

      <McpConfigSnippet />

      <RevokeDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Revoke ${target?.name ?? "this token"}?`}
        description="Tools using it lose access right away. This can't be undone."
        confirmLabel="Revoke token"
        pendingLabel="Revoking…"
        pending={revoke.isPending}
        error={revoke.error}
        onConfirm={confirmRevoke}
      />
    </div>
  );
}

function TokenRow({ token, onRevoke }: { token: AccessToken; onRevoke: () => void }) {
  return (
    <tr className="h-10 border-divider border-t first:border-t-0">
      <td className={td("pl-3.5")}>
        <span className="block truncate text-body text-foreground">{token.name}</span>
      </td>
      <td className={td("hidden md:table-cell")}>
        <span className="block truncate font-mono text-mono text-muted-foreground">
          {token.prefix}…
        </span>
      </td>
      <td className={td("hidden sm:table-cell")}>
        <span className="flex gap-1 overflow-hidden">
          {token.scopes.map((scope) => (
            <Badge
              key={scope}
              variant={scope === "mcp:admin" ? "default" : "secondary"}
              title={scope}
            >
              {SCOPE_LABELS[scope]}
            </Badge>
          ))}
        </span>
      </td>
      <td className={td("text-right")}>
        {token.lastUsedAt ? (
          <RelativeTime
            value={token.lastUsedAt}
            className="font-mono text-[11px] text-muted-foreground"
          />
        ) : (
          <span className="text-small text-muted-foreground">Never</span>
        )}
      </td>
      <td className={td("hidden text-right md:table-cell")}>
        <RelativeTime
          value={token.createdAt}
          className="font-mono text-[11px] text-muted-foreground"
        />
      </td>
      <td className={td("pr-2 text-right")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Revoke ${token.name}`}
          title="Revoke"
          onClick={onRevoke}
        >
          <Trash2Icon aria-hidden="true" />
        </Button>
      </td>
    </tr>
  );
}
