import type { Workspace } from "@loomcast/contracts";
import { Badge } from "@loomcast/ui/components/badge";
import { Button } from "@loomcast/ui/components/button";
import { StatusPill } from "@loomcast/ui/components/StatusPill";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, MessagesSquareIcon, SlidersHorizontalIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { PlatformDot, platformLabel, sortChannels } from "@/features/channels/platforms";
import { channelsQueryOptions } from "@/features/channels/queries";
import { conversationTitle } from "@/features/conversation/messages";
import { conversationsQueryOptions } from "@/features/conversation/queries";
import { KbRow, KbRowsSkeleton } from "@/features/kb/KbRow";
import { kbListQueryOptions, kbTagsQueryOptions } from "@/features/kb/queries";
import { DescriptionEditor } from "./DescriptionEditor";
import { OverviewCard, OverviewRowsSkeleton } from "./OverviewCard";
import { WorkspaceAvatar } from "./WorkspaceAvatar";

const RECENT_LIMIT = 5;

/** The Overview: what the workspace is, how much is in it, where it publishes and what changed lately. */
export function WorkspaceOverview({ workspace }: { workspace: Workspace }) {
  const conversations = useQuery(conversationsQueryOptions(workspace.id));
  // The same cache as the Knowledge page's unfiltered list.
  const knowledge = useInfiniteQuery(kbListQueryOptions(workspace.id, { kind: "all", tag: null }));
  const tags = useQuery(kbTagsQueryOptions(workspace.id));
  const entries = knowledge.data?.pages.flatMap((page) => page.items);

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader workspace={workspace} />
      <DescriptionEditor workspace={workspace} />

      <dl aria-label="Workspace stats" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Conversations" pending={conversations.isPending}>
          {conversations.data?.length ?? "–"}
        </Stat>
        <Stat label="Knowledge entries" pending={knowledge.isPending}>
          {entries ? `${entries.length}${knowledge.hasNextPage ? "+" : ""}` : "–"}
        </Stat>
        <Stat label="Tags" pending={tags.isPending}>
          {tags.data?.length ?? "–"}
        </Stat>
        <Stat label="Last change">
          <RelativeTime value={workspace.updatedAt} />
        </Stat>
      </dl>

      <div className="grid gap-5 lg:grid-cols-2">
        <OverviewCard
          title="Recent knowledge"
          action={
            <Button asChild variant="ghost" size="sm">
              <Link to="/w/$workspace/kb" params={{ workspace: workspace.slug }}>
                Open knowledge
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
          }
        >
          {knowledge.isPending ? (
            <KbRowsSkeleton rows={3} />
          ) : knowledge.isError ? (
            <ErrorState
              size="compact"
              title="Couldn't load the knowledge base"
              error={knowledge.error}
              onRetry={() => void knowledge.refetch()}
              retrying={knowledge.isFetching}
            />
          ) : !entries?.length ? (
            <p className="px-3.5 py-6 text-center text-control text-muted-foreground">
              Nothing saved yet. Add ideas, references and decisions in Knowledge.
            </p>
          ) : (
            <ul aria-label="Recent knowledge" className="divide-y divide-divider">
              {entries.slice(0, RECENT_LIMIT).map((entry) => (
                <li key={entry.id}>
                  <KbRow entry={entry} workspaceParam={workspace.id} />
                </li>
              ))}
            </ul>
          )}
        </OverviewCard>
        <OverviewCard
          title="Recent conversations"
          action={
            <Button asChild variant="ghost" size="sm">
              <Link to="/w/$workspace/chat" params={{ workspace: workspace.slug }}>
                Open chat
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
          }
        >
          {conversations.isPending ? (
            <OverviewRowsSkeleton />
          ) : conversations.isError ? (
            <ErrorState
              size="compact"
              title="Couldn't load the conversations"
              error={conversations.error}
              onRetry={() => void conversations.refetch()}
              retrying={conversations.isFetching}
            />
          ) : conversations.data.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-control text-muted-foreground">
              No conversations yet. Start one in Chat.
            </p>
          ) : (
            <ul aria-label="Recent conversations" className="divide-y divide-divider">
              {conversations.data.slice(0, RECENT_LIMIT).map((conversation) => (
                <li key={conversation.id}>
                  <Link
                    to="/w/$workspace/chat"
                    params={{ workspace: workspace.slug }}
                    search={{ conversation: conversation.id }}
                    className="flex h-9 items-center gap-2.5 px-3.5 outline-none transition-colors hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    <MessagesSquareIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate text-body">
                      {conversationTitle(conversation)}
                    </span>
                    <RelativeTime
                      value={conversation.lastMessageAt ?? conversation.createdAt}
                      className="w-11 shrink-0 text-right font-mono text-[11px] text-muted-foreground"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </OverviewCard>
      </div>

      <ChannelsSummary workspace={workspace} />
    </div>
  );
}

function WorkspaceHeader({ workspace }: { workspace: Workspace }) {
  return (
    <header className="flex items-start gap-3">
      <WorkspaceAvatar workspace={workspace} className="mt-[3px] size-7 rounded-md text-[13px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="text-title break-words">{workspace.name}</h1>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted-foreground">
          <code className="max-w-full truncate font-mono text-mono">{workspace.slug}</code>
          <span aria-hidden="true">·</span>
          <span>
            Updated <RelativeTime value={workspace.updatedAt} format="relative" />
          </span>
          {workspace.status === "archived" ? <Badge variant="secondary">Archived</Badge> : null}
        </div>
      </div>
      <Button asChild variant="outline" size="sm" className="shrink-0">
        <Link to="/w/$workspace/settings" params={{ workspace: workspace.slug }}>
          <SlidersHorizontalIcon aria-hidden="true" />
          <span className="max-sm:sr-only">Settings</span>
        </Link>
      </Button>
    </header>
  );
}

/** Where the workspace publishes: each channel with its platform and status. */
function ChannelsSummary({ workspace }: { workspace: Workspace }) {
  const channels = useQuery(channelsQueryOptions(workspace.id));
  const list = sortChannels(channels.data?.items ?? []);
  const params = { workspace: workspace.slug };
  return (
    <OverviewCard
      title="Channels"
      action={
        <Button asChild variant="ghost" size="sm">
          <Link to="/w/$workspace/settings/channels" params={params}>
            Manage channels
            <ArrowRightIcon aria-hidden="true" />
          </Link>
        </Button>
      }
    >
      {channels.isPending ? (
        <OverviewRowsSkeleton />
      ) : channels.isError ? (
        <ErrorState
          size="compact"
          title="Couldn't load the channels"
          error={channels.error}
          onRetry={() => void channels.refetch()}
          retrying={channels.isFetching}
        />
      ) : list.length === 0 ? (
        <p className="px-3.5 py-6 text-center text-control text-muted-foreground">
          No channels yet. Connect this workspace's accounts in its channel settings.
        </p>
      ) : (
        <ul aria-label="Workspace channels" className="divide-y divide-divider">
          {list.map((channel) => (
            <li key={channel.id}>
              <Link
                to="/w/$workspace/calendar"
                params={params}
                search={{ channels: channel.id }}
                className="flex h-9 items-center gap-2.5 px-3.5 outline-none transition-colors hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <PlatformDot platform={channel.platform} />
                <span className="min-w-0 flex-1 truncate text-body">{channel.displayName}</span>
                <span className="shrink-0 text-small text-muted-foreground max-sm:hidden">
                  {platformLabel(channel.platform)}
                </span>
                <StatusPill kind="channel" status={channel.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </OverviewCard>
  );
}

function Stat({
  label,
  pending = false,
  children,
}: {
  label: string;
  pending?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-card px-3.5 py-3 shadow-card">
      <dt className="text-small text-muted-foreground">{label}</dt>
      <dd className="truncate font-semibold text-heading tabular-nums">
        {pending ? <Skeleton aria-hidden="true" className="my-1 h-4 w-10" /> : children}
      </dd>
    </div>
  );
}
