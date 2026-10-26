import type { Channel, Series } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { toast } from "sonner";
import { errorMessage, isApiError } from "@/lib/api";
import { channelLabel, PlatformDot, sortChannels } from "./platforms";
import { channelsQueryOptions, seriesChannelsQueryOptions, useSetSeriesChannel } from "./queries";
import { SwitchField } from "./SwitchField";

/** Why a series' channel switch is locked, or null when it can be flipped. */
export function seriesChannelLock(
  series: Pick<Series, "status">,
  channel: Pick<Channel, "status">,
  enabled: boolean,
): string | null {
  if (series.status === "archived") return "The series is archived, so its channels can't change.";
  // A disabled channel can be switched off for the series, never on.
  if (channel.status === "disabled" && !enabled) return "The channel is disabled.";
  return null;
}

/**
 * The channels a series publishes to, each with a switch. Switching one off keeps its posts and
 * plans nothing new on it; switching one on plans the series' next slots there.
 */
export function SeriesChannelsCard({
  series,
  workspaceParam,
}: {
  series: Series;
  /** The workspace as it appears in the address (id or slug), for links. */
  workspaceParam: string;
}) {
  const id = useId();
  const channels = useQuery(channelsQueryOptions(series.workspaceId));
  const links = useQuery(seriesChannelsQueryOptions(series.id));
  const setLink = useSetSeriesChannel(series.id);

  if (channels.isPending || links.isPending) {
    return (
      <div aria-hidden="true" className="flex flex-col gap-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-32" />
      </div>
    );
  }
  if (channels.isError || links.isError) {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <p className="text-small text-muted-foreground">Couldn't load the channels.</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void channels.refetch();
            void links.refetch();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  const enabledById = new Map(links.data.channels.map((link) => [link.channelId, link.enabled]));
  // Disabled channels show only while still linked to the series.
  const shown = sortChannels(channels.data.items).filter(
    (channel) => channel.status !== "disabled" || enabledById.has(channel.id),
  );
  if (shown.length === 0) {
    return (
      <p className="text-small text-muted-foreground">
        No channels yet.{" "}
        <Link
          to="/w/$workspace/settings/channels"
          params={{ workspace: workspaceParam }}
          className="text-foreground underline underline-offset-2"
        >
          Add one in the workspace settings
        </Link>{" "}
        to plan this series' posts.
      </p>
    );
  }

  const toggle = (channel: Channel, enabled: boolean) =>
    setLink.mutate(
      { channelId: channel.id, enabled },
      {
        onError: (error) => {
          const reason = (error as { details?: { reason?: string } }).details?.reason;
          toast.error(`Couldn't ${enabled ? "add" : "pause"} ${channelLabel(channel)}`, {
            description:
              isApiError(error, 409) && reason === "archived_series"
                ? "The series is archived."
                : isApiError(error, 409) && reason === "channel_disabled"
                  ? "The channel is disabled."
                  : errorMessage(error),
          });
        },
      },
    );

  return (
    <>
      <ul aria-label={`Channels of ${series.name}`} className="flex flex-col gap-2">
        {shown.map((channel) => {
          const enabled = enabledById.get(channel.id) ?? false;
          const lock = seriesChannelLock(series, channel, enabled);
          const notes = [
            channel.dryRun ? "dry run" : null,
            channel.requiresApproval ? "approval" : null,
          ].filter(Boolean);
          return (
            <li key={channel.id} className="flex min-w-0 items-center gap-2">
              <PlatformDot platform={channel.platform} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-control text-foreground">{channel.displayName}</span>
                {notes.length > 0 ? (
                  <span className="truncate text-[11.5px] text-muted-foreground">
                    {notes.join(" · ")}
                  </span>
                ) : null}
              </span>
              <SwitchField
                id={`${id}-${channel.id}`}
                label={enabled ? "On" : "Off"}
                name={`Publish ${series.name} to ${channelLabel(channel)}`}
                checked={enabled}
                disabled={lock !== null}
                reason={lock}
                onCheckedChange={(next) => toggle(channel, next)}
              />
            </li>
          );
        })}
      </ul>
      <p className="text-[11.5px] text-muted-foreground text-pretty">
        Switching a channel off keeps its posts and plans nothing new on it.
      </p>
    </>
  );
}
