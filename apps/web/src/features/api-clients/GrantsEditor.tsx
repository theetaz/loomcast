import {
  API_CHANNEL_ACCESS,
  type ApiChannelAccess,
  type ApiChannelGrant,
  type Channel,
} from "@loomcast/contracts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import {
  channelLabel,
  PLATFORM_ORDER,
  PlatformDot,
  platformLabel,
  sortChannels,
} from "@/features/channels/platforms";
import { ACCESS_DESCRIPTIONS, ACCESS_LABELS } from "./queries";

/** A channel's level in the editor; `none` leaves it out of the grants. */
export type GrantLevel = ApiChannelAccess | "none";

export type GrantDraft = ReadonlyMap<string, GrantLevel>;

/** The grants a draft stands for, in channel order. */
export function draftGrants(channels: readonly Channel[], draft: GrantDraft): ApiChannelGrant[] {
  return sortChannels(channels).flatMap((channel) => {
    const access = draft.get(channel.id) ?? "none";
    return access === "none" ? [] : [{ channelId: channel.id, access }];
  });
}

export function draftFrom(grants: readonly ApiChannelGrant[]): Map<string, GrantLevel> {
  return new Map(grants.map((grant) => [grant.channelId, grant.access]));
}

const LEVELS: readonly GrantLevel[] = ["none", ...API_CHANNEL_ACCESS];

function levelLabel(level: GrantLevel): string {
  return level === "none" ? "No access" : ACCESS_LABELS[level];
}

/**
 * Every channel, grouped by platform, with a level per channel: no access (the
 * default), read, write or publish. Each level includes the ones before it.
 */
export function GrantsEditor({
  channels,
  value,
  onChange,
  describedBy,
}: {
  channels: readonly Channel[];
  value: GrantDraft;
  onChange: (next: Map<string, GrantLevel>) => void;
  describedBy?: string;
}) {
  const sorted = sortChannels(channels);
  const groups = PLATFORM_ORDER.map((platform) => ({
    platform,
    channels: sorted.filter((channel) => channel.platform === platform),
  })).filter((group) => group.channels.length > 0);

  return (
    <div aria-describedby={describedBy} className="grid gap-3">
      {groups.map((group) => (
        <div key={group.platform} className="grid gap-1">
          <p className="font-medium text-[11.5px] text-muted-foreground">
            {platformLabel(group.platform)}
          </p>
          <ul className="overflow-hidden rounded-md bg-card shadow-card">
            {group.channels.map((channel) => {
              const level = value.get(channel.id) ?? "none";
              return (
                <li
                  key={channel.id}
                  className="flex items-center gap-2.5 border-divider border-t px-3 py-2 first:border-t-0"
                >
                  <PlatformDot platform={channel.platform} />
                  <div className="grid min-w-0 flex-1">
                    <span className="truncate text-control text-foreground">
                      {channel.displayName}
                    </span>
                    <span className="truncate text-small text-muted-foreground">
                      {ACCESS_DESCRIPTIONS[level]}
                    </span>
                  </div>
                  <Select
                    value={level}
                    onValueChange={(next) => {
                      const updated = new Map(value);
                      updated.set(channel.id, next as GrantLevel);
                      onChange(updated);
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-[118px] shrink-0"
                      aria-label={`Access to ${channelLabel(channel)}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LEVELS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {levelLabel(option)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
