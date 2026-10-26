import type { ApiClient, Workspace } from "@loomcast/contracts";
import { Badge } from "@loomcast/ui/components/badge";
import { Button } from "@loomcast/ui/components/button";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { PencilIcon, PlusIcon, ServerIcon, ShieldIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { useMe } from "@/features/auth/queries";
import { channelLabel, PlatformDot } from "@/features/channels/platforms";
import { CodeBlock } from "@/features/settings/CopyButton";
import { RevokeDialog } from "@/features/settings/RevokeDialog";
import { SettingsCard, TableSkeleton, td, th } from "@/features/settings/SettingsCard";
import { API_V1_PATH, ApiClientDialog } from "./ApiClientDialog";
import {
  ACCESS_LABELS,
  type ApiClientStatus,
  apiClientsQueryOptions,
  clientStatus,
  useRevokeApiClient,
} from "./queries";

export const KEY_PLACEHOLDER = "<your-api-key>";

/** Owner only: the backends that schedule posts on the workspace's channels through the machine API. */
export function ApiClientsSettings({ workspace }: { workspace: Workspace }) {
  const me = useMe();
  if (me.role !== "owner") return <OwnerOnly />;
  return <ApiClientsList workspace={workspace} />;
}

function OwnerOnly() {
  return (
    <div className="rounded-lg bg-card shadow-card">
      <EmptyState
        icon={ShieldIcon}
        title="Only the owner manages API clients"
        description="Ask the workspace owner to connect a backend or to change what it may do."
      />
    </div>
  );
}

function ApiClientsList({ workspace }: { workspace: Workspace }) {
  const query = useQuery(apiClientsQueryOptions(workspace.id));
  const revoke = useRevokeApiClient();
  // Targets outlive the open flags so dialogs keep their titles while they fade out.
  const [editing, setEditing] = useState<ApiClient | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiClient | null>(null);
  const [confirming, setConfirming] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const confirmRevoke = () => {
    if (!revokeTarget) return;
    revoke.mutate(revokeTarget, {
      onSuccess: () => {
        setConfirming(false);
        toast.success("API client revoked", { description: revokeTarget.name });
      },
    });
  };

  const newButton = (size?: "sm") => (
    <Button size={size} onClick={openCreate}>
      <PlusIcon aria-hidden="true" />
      New client
    </Button>
  );

  return (
    <div className="grid gap-4">
      <SettingsCard
        title="API clients"
        count={query.isSuccess ? query.data.length : null}
        busy={query.isPending}
        action={newButton("sm")}
      >
        {query.isPending ? (
          <TableSkeleton columns={["w-20", "w-24", "w-10", "w-12"]} />
        ) : query.isError ? (
          <ErrorState
            size="compact"
            title="Couldn't load API clients"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : query.data.length === 0 ? (
          <EmptyState
            icon={ServerIcon}
            title="No API clients"
            description={`Create a client for each backend that should schedule posts on ${workspace.name}'s channels.`}
            action={newButton()}
          />
        ) : (
          <table aria-label="API clients" className="w-full table-fixed text-left">
            <thead>
              <tr className="h-9 border-divider border-b">
                <th scope="col" className={th("pl-3.5")}>
                  Name
                </th>
                <th scope="col" className={th("hidden w-[40%] sm:table-cell")}>
                  Channels
                </th>
                <th scope="col" className={th("w-[84px] text-right")}>
                  Last used
                </th>
                <th scope="col" className={th("hidden w-[96px] md:table-cell")}>
                  Status
                </th>
                <th scope="col" className={th("w-[76px] pr-2")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((client) => (
                <ClientRow
                  key={client.id}
                  client={client}
                  onEdit={() => {
                    setEditing(client);
                    setDialogOpen(true);
                  }}
                  onRevoke={() => {
                    revoke.reset();
                    setRevokeTarget(client);
                    setConfirming(true);
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </SettingsCard>

      <ApiUsageSnippet />

      <ApiClientDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        client={editing}
        workspace={workspace}
      />

      <RevokeDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Revoke ${revokeTarget?.name ?? "this client"}?`}
        description="Its key stops working right away. Posts it already scheduled stay on the calendar. This can't be undone."
        confirmLabel="Revoke client"
        pendingLabel="Revoking…"
        pending={revoke.isPending}
        error={revoke.error}
        onConfirm={confirmRevoke}
      />
    </div>
  );
}

const STATUS_LABELS: Record<ApiClientStatus, string> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
};

function ClientRow({
  client,
  onEdit,
  onRevoke,
}: {
  client: ApiClient;
  onEdit: () => void;
  onRevoke: () => void;
}) {
  const status = clientStatus(client);
  const working = status === "active";
  return (
    <tr
      className={cn(
        "h-12 border-divider border-t first:border-t-0",
        !working && "text-muted-foreground",
      )}
    >
      <td className={td("pl-3.5")}>
        <span className="block truncate text-body text-foreground">{client.name}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {client.prefix}…
        </span>
      </td>
      <td className={td("hidden sm:table-cell")}>
        <ul aria-label={`Channels of ${client.name}`} className="flex flex-wrap gap-1 py-1">
          {client.grants.map((grant) => (
            <li key={grant.channelId}>
              <Badge
                variant={grant.access === "publish" ? "default" : "secondary"}
                title={`${channelLabel({ displayName: grant.channelName, platform: grant.platform })}: ${ACCESS_LABELS[grant.access]}`}
                className="max-w-[180px] gap-1"
              >
                <PlatformDot platform={grant.platform} />
                <span className="truncate">{grant.channelName}</span>
                <span className="opacity-70">· {ACCESS_LABELS[grant.access]}</span>
              </Badge>
            </li>
          ))}
        </ul>
      </td>
      <td className={td("text-right")}>
        {client.lastUsedAt ? (
          <RelativeTime
            value={client.lastUsedAt}
            className="font-mono text-[11px] text-muted-foreground"
          />
        ) : (
          <span className="text-small text-muted-foreground">Never</span>
        )}
      </td>
      <td className={td("hidden md:table-cell")}>
        <span className="grid">
          <span className={cn("text-small", working ? "text-status-green" : undefined)}>
            {STATUS_LABELS[status]}
          </span>
          {working && client.expiresAt ? (
            <span className="text-[11px] text-muted-foreground">
              Expires <RelativeTime value={client.expiresAt} />
            </span>
          ) : null}
        </span>
      </td>
      <td className={td("pr-2 text-right")}>
        {status === "revoked" ? null : (
          <span className="inline-flex gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${client.name}`}
              title="Edit"
              onClick={onEdit}
            >
              <PencilIcon aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Revoke ${client.name}`}
              title="Revoke"
              onClick={onRevoke}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          </span>
        )}
      </td>
    </tr>
  );
}

/** A first request with a placeholder key: real keys appear only in the one-time reveal. */
export function apiUsageExample(origin: string): string {
  return [
    `curl ${origin}${API_V1_PATH}/channels \\`,
    `  -H "Authorization: Bearer ${KEY_PLACEHOLDER}"`,
  ].join("\n");
}

function ApiUsageSnippet() {
  return (
    <section
      aria-labelledby="api-usage-title"
      className="overflow-hidden rounded-lg bg-card shadow-card"
    >
      <div className="flex h-11 items-center border-divider border-b px-3.5">
        <h2 id="api-usage-title" className="font-semibold text-[13px]">
          Connect a backend
        </h2>
      </div>
      <div className="grid gap-3 p-3.5">
        <p className="text-control text-muted-foreground text-pretty">
          Backends call the REST API under{" "}
          <code className="font-mono text-mono text-foreground">{API_V1_PATH}</code> with the
          client's key as a bearer header. The full reference for people and language models is at{" "}
          <a className="text-foreground underline underline-offset-2" href="/llms.txt">
            /llms.txt
          </a>
          .
        </p>
        <CodeBlock
          value={apiUsageExample(window.location.origin)}
          copyLabel="Copy example request"
          overflow="scroll"
          codeClassName="leading-[1.6]"
        />
      </div>
    </section>
  );
}
