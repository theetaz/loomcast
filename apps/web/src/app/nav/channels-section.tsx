import type { Channel } from "@loomcast/contracts";
import { StatusDot } from "@loomcast/ui/components/StatusPill";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@loomcast/ui/components/sidebar";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LockIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { channelLabel, PlatformDot, sortChannels } from "@/features/channels/platforms";
import { channelsQueryOptions, useChannelsLive } from "@/features/channels/queries";
import { isPlatformLocked } from "@/features/channels/rules";

const STATUS_NOTES: Partial<Record<Channel["status"], string>> = {
  needs_reauth: "needs reconnecting",
  disabled: "disabled",
};

/**
 * The channels series publish to. Each opens the calendar filtered to it; a channel that needs
 * reconnecting carries an amber dot and X channels a lock while they can only dry-run. The group
 * action opens Settings → Channels. Kept light: it is part of the entry chunk.
 */
export function ChannelsSection() {
  useChannelsLive();
  const { isMobile, setOpenMobile } = useSidebar();
  const query = useQuery(channelsQueryOptions());
  const close = () => isMobile && setOpenMobile(false);
  const channels = sortChannels(query.data?.items ?? []);

  return (
    <SidebarGroup className="pt-3">
      <SidebarGroupLabel className="text-muted-foreground">Channels</SidebarGroupLabel>
      <SidebarGroupAction asChild title="Manage channels">
        <Link to="/settings/channels" onClick={close} aria-label="Manage channels">
          <Settings2Icon aria-hidden="true" />
        </Link>
      </SidebarGroupAction>
      <SidebarMenu aria-label="Channels">
        {query.isPending ? (
          <>
            <SidebarMenuItem>
              <SidebarMenuSkeleton />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuSkeleton />
            </SidebarMenuItem>
          </>
        ) : channels.length === 0 ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="text-muted-foreground">
              <Link to="/settings/channels" onClick={close}>
                <PlusIcon aria-hidden="true" />
                <span>{query.isError ? "Manage channels" : "Add a channel"}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : (
          channels.map((channel) => {
            const note = STATUS_NOTES[channel.status];
            const locked = isPlatformLocked(channel);
            return (
              <SidebarMenuItem key={channel.id} data-channel-id={channel.id}>
                <SidebarMenuButton
                  asChild
                  className={channel.status === "disabled" ? "opacity-60" : undefined}
                >
                  <Link
                    to="/calendar"
                    search={{ channels: channel.id }}
                    onClick={close}
                    aria-label={`${channelLabel(channel)}${note ? `, ${note}` : ""}${locked ? ", dry-run only" : ""}`}
                  >
                    <PlatformDot platform={channel.platform} className="mr-0.5 ml-1" />
                    <span className="min-w-0 flex-1 truncate">{channel.displayName}</span>
                    {locked ? (
                      <LockIcon aria-hidden="true" className="size-3! text-muted-foreground" />
                    ) : null}
                    {channel.status === "needs_reauth" ? (
                      <StatusDot kind="channel" status={channel.status} />
                    ) : null}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
