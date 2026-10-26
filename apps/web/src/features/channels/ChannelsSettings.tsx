import {
  type Channel,
  LivePublishingBlockerSchema,
  oauthProviderForPlatform,
  type Workspace,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { PlusIcon, RadioTowerIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { SettingsCard, TableSkeleton } from "@/features/settings/SettingsCard";
import { errorMessage, isApiError } from "@/lib/api";
import { useNow } from "@/lib/use-now";
import { AddChannelDialog } from "./AddChannelDialog";
import { ChannelRow } from "./ChannelRow";
import { ConnectButton } from "./ConnectButton";
import { startOAuth } from "./connect/navigation";
import { connectProviders } from "./connect/providers";
import { useXPublishing } from "./connect/queries";
import { DisconnectChannelDialog } from "./DisconnectChannelDialog";
import { GoLiveDialog } from "./GoLiveDialog";
import { PublisherBanner } from "./PublisherBanner";
import { channelLabel, sortChannels } from "./platforms";
import {
  channelsQueryOptions,
  type UpdateChannelInput,
  useChannelsLive,
  useUpdateChannel,
} from "./queries";
import { RenameChannelDialog } from "./RenameChannelDialog";
import { liveBlockerReason } from "./rules";

/** Says why a switch went back: the server's dry-run reason, or the error. */
function reportFailure(error: Error, { channel }: UpdateChannelInput) {
  if (isApiError(error, 409) && error.code === "dry_run_locked") {
    const parsed = LivePublishingBlockerSchema.safeParse(
      (error.details as { reason?: unknown } | undefined)?.reason,
    );
    toast.error(`${channelLabel(channel)} can't leave dry-run`, {
      description: parsed.success
        ? liveBlockerReason(parsed.data, channel.platform)
        : error.message,
    });
    return;
  }
  toast.error(`Couldn't update ${channelLabel(channel)}`, { description: errorMessage(error) });
}

/**
 * Workspace settings → Channels: the workspace's channels with their status and switches, the
 * server's dry-run banner, planning channels, connecting and reconnecting accounts, and
 * disconnecting them. New channels join this workspace.
 */
export function ChannelsSettings({ workspace }: { workspace: Workspace }) {
  useChannelsLive();
  const now = useNow();
  const query = useQuery(channelsQueryOptions(workspace.id));
  const update = useUpdateChannel({ onFailure: reportFailure });
  const [goingLive, setGoingLive] = useState<Channel | null>(null);
  const [renaming, setRenaming] = useState<Channel | null>(null);
  const [disconnecting, setDisconnecting] = useState<Channel | null>(null);
  const providers = connectProviders(useXPublishing());
  const reconnect = (channel: Channel) =>
    startOAuth(oauthProviderForPlatform(channel.platform), workspace);
  const channels = useMemo(() => sortChannels(query.data?.items ?? []), [query.data]);

  const save = (channel: Channel, change: { dryRun?: boolean; requiresApproval?: boolean }) =>
    update.mutate({ channel, change });

  const onDryRunChange = (channel: Channel, dryRun: boolean) => {
    if (dryRun) save(channel, { dryRun: true });
    else setGoingLive(channel);
  };

  return (
    <div className="flex flex-col gap-3">
      <PublisherBanner />
      <SettingsCard
        title="Channels"
        count={query.isSuccess ? channels.length : null}
        busy={query.isPending}
        action={
          <>
            <ConnectButton workspace={workspace} />
            <AddChannelDialog workspaceId={workspace.id}>
              <Button size="sm" aria-label="Add planning channel">
                <PlusIcon aria-hidden="true" />
                Add<span className="max-sm:hidden"> planning channel</span>
              </Button>
            </AddChannelDialog>
          </>
        }
      >
        {query.isPending ? (
          <TableSkeleton columns={["w-20", "w-20", "w-6"]} />
        ) : query.isError ? (
          <ErrorState
            size="compact"
            title="Couldn't load channels"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : channels.length === 0 ? (
          <EmptyState
            size="compact"
            icon={RadioTowerIcon}
            title="No channels yet"
            description={`Channels are the accounts ${workspace.name} publishes to: Facebook Pages, Instagram and Threads. Connect an account, or add a planning channel to plan posts before connecting one.`}
            action={
              <>
                <ConnectButton workspace={workspace} size="default" />
                <AddChannelDialog workspaceId={workspace.id}>
                  <Button>
                    <PlusIcon aria-hidden="true" />
                    Add planning channel
                  </Button>
                </AddChannelDialog>
              </>
            }
          />
        ) : (
          <ul aria-label="Channel settings">
            {channels.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                now={now}
                onDryRunChange={onDryRunChange}
                onRequiresApprovalChange={(target, requiresApproval) =>
                  save(target, { requiresApproval })
                }
                onRename={setRenaming}
                onReconnect={
                  providers.includes(oauthProviderForPlatform(channel.platform))
                    ? reconnect
                    : undefined
                }
                onDisconnect={setDisconnecting}
              />
            ))}
          </ul>
        )}
      </SettingsCard>
      <p className="px-1 text-small text-muted-foreground text-pretty">
        Dry run records the exact request a post would send without publishing it. Approval makes
        every post on the channel wait for a person, whatever the series' publish mode.
      </p>

      <GoLiveDialog
        channel={goingLive}
        onCancel={() => setGoingLive(null)}
        onConfirm={(channel) => {
          setGoingLive(null);
          save(channel, { dryRun: false });
        }}
      />
      <RenameChannelDialog channel={renaming} onClose={() => setRenaming(null)} />
      <DisconnectChannelDialog channel={disconnecting} onClose={() => setDisconnecting(null)} />
    </div>
  );
}
