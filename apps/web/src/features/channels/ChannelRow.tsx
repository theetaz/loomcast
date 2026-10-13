import type { Channel } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loomcast/ui/components/dropdown-menu";
import { StatusPill } from "@loomcast/ui/components/StatusPill";
import { cn } from "@loomcast/ui/lib/cn";
import {
  LockIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react";
import { type ReactNode, useId } from "react";
import { RelativeTime } from "@/components/RelativeTime";
import { ChannelPicture, channelLabel, platformLabel } from "./platforms";
import { dryRunSwitchState, isPlatformLocked, tokenExpiryWarning } from "./rules";
import { SwitchField } from "./SwitchField";

export interface ChannelRowProps {
  channel: Channel;
  now: number;
  /** Asks to switch dry-run on or off; the page confirms going live first. */
  onDryRunChange: (channel: Channel, dryRun: boolean) => void;
  onRequiresApprovalChange: (channel: Channel, requiresApproval: boolean) => void;
  onRename: (channel: Channel) => void;
  /** Signs in again with the channel's platform; absent while the server can't connect it. */
  onReconnect?: (channel: Channel) => void;
  /** Asks to disconnect the channel; the page confirms first. */
  onDisconnect: (channel: Channel) => void;
}

/**
 * One channel: the platform tile, its name and status, what to know about its access, and the
 * dry-run and approval switches. The dry-run switch follows the server's `liveBlocker`: while one
 * is set the switch stays on and says why.
 */
export function ChannelRow({
  channel,
  now,
  onDryRunChange,
  onRequiresApprovalChange,
  onRename,
  onReconnect,
  onDisconnect,
}: ChannelRowProps) {
  const id = useId();
  const label = channelLabel(channel);
  const dryRun = dryRunSwitchState(channel);
  const expiry = tokenExpiryWarning(channel, now);
  const locked = isPlatformLocked(channel);
  const needsReauth = channel.status === "needs_reauth";

  return (
    <li
      data-channel-id={channel.id}
      aria-label={label}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2.5 border-divider border-t px-3.5 py-3 first:border-t-0",
        channel.status === "disabled" && "opacity-70",
      )}
    >
      <ChannelPicture platform={channel.platform} pictureUrl={channel.pictureUrl} />
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-body text-foreground">
            {channel.displayName}
          </span>
          <StatusPill kind="channel" status={channel.status} />
          {locked ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-small text-muted-foreground">
              <LockIcon aria-hidden="true" className="size-3" />
              Dry-run only
            </span>
          ) : null}
        </div>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-small text-muted-foreground">
          <span>{platformLabel(channel.platform)}</span>
          {channel.username && channel.username !== channel.displayName.replace(/^@/, "") ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">@{channel.username}</span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          {channel.connected ? (
            channel.lastVerifiedAt ? (
              <span>
                Checked <RelativeTime value={channel.lastVerifiedAt} format="relative" />
              </span>
            ) : (
              <span>Connected</span>
            )
          ) : (
            <span>Planning channel, no account connected</span>
          )}
        </p>
        {channel.lastError && !needsReauth ? (
          <Notice tone="red">
            The platform refused the stored access: {channel.lastError.message}
          </Notice>
        ) : null}
        {expiry ? <Notice tone={expiry.tone}>{expiry.message}</Notice> : null}
      </div>

      <div className="flex shrink-0 items-center gap-4 max-sm:w-full max-sm:pl-10">
        <SwitchField
          id={`${id}-dry-run`}
          label="Dry run"
          name={`Dry run for ${label}`}
          checked={dryRun.checked}
          disabled={dryRun.disabled}
          reason={dryRun.reason}
          onCheckedChange={(checked) => onDryRunChange(channel, checked)}
        />
        <SwitchField
          id={`${id}-approval`}
          label="Approval"
          name={`Requires approval for ${label}`}
          checked={channel.requiresApproval}
          onCheckedChange={(checked) => onRequiresApprovalChange(channel, checked)}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`More for ${label}`}
              className="max-sm:ml-auto"
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onRename(channel)}>
              <PencilIcon aria-hidden="true" />
              Rename…
            </DropdownMenuItem>
            {channel.connected && onReconnect ? (
              <DropdownMenuItem onSelect={() => onReconnect(channel)}>
                <RefreshCwIcon aria-hidden="true" />
                Reconnect
              </DropdownMenuItem>
            ) : null}
            {channel.connected ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onDisconnect(channel)}>
                  <UnplugIcon aria-hidden="true" />
                  Disconnect…
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {needsReauth ? <ReauthBanner channel={channel} onReconnect={onReconnect} /> : null}
    </li>
  );
}

function Notice({ tone, children }: { tone: "red" | "amber"; children: ReactNode }) {
  return (
    <p
      className={cn(
        "flex min-w-0 items-start gap-1.5 text-small",
        tone === "red" ? "text-status-red" : "text-status-amber",
      )}
    >
      <TriangleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 text-pretty">{children}</span>
    </p>
  );
}

/**
 * A channel that needs reconnecting: the platform refused its stored access, so nothing publishes
 * until the user signs in again. Reconnecting keeps the channel's name, switches and posts.
 */
function ReauthBanner({
  channel,
  onReconnect,
}: {
  channel: Channel;
  onReconnect: ((channel: Channel) => void) | undefined;
}) {
  const platform = platformLabel(channel.platform);
  return (
    <div
      data-reauth=""
      className="flex basis-full flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-status-amber/11 px-3 py-2 sm:ml-10"
    >
      <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-status-amber" />
      <div className="min-w-0 flex-1 basis-48 text-small text-pretty">
        <p className="font-medium text-foreground">
          Reconnect to keep publishing. Nothing posts to {platform} until you do.
        </p>
        {channel.lastError ? (
          <p className="text-muted-foreground">
            The platform refused the stored access: {channel.lastError.message}
          </p>
        ) : null}
      </div>
      {onReconnect ? (
        <Button size="sm" onClick={() => onReconnect(channel)}>
          <RefreshCwIcon aria-hidden="true" />
          Reconnect
        </Button>
      ) : (
        <span className="text-small text-muted-foreground">
          Connecting {platform} isn't available on this server.
        </span>
      )}
    </div>
  );
}
