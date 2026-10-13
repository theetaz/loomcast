import type { Project } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, MessagesSquareIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { conversationTitle } from "@/features/conversation/messages";
import { conversationsQueryOptions } from "@/features/conversation/queries";
import { formatDateTime } from "@/lib/format";
import { ArchiveProject } from "./ArchiveProject";
import { DescriptionEditor } from "./DescriptionEditor";
import { OverviewCard, OverviewRowsSkeleton } from "./OverviewCard";

const RECENT_LIMIT = 5;

/** The Overview tab: what the project is, how much is in it, and what changed lately. */
export function ProjectOverview({ project }: { project: Project }) {
  const conversations = useQuery(conversationsQueryOptions(project.id));

  return (
    <div className="flex flex-col gap-5">
      <DescriptionEditor project={project} />

      <dl aria-label="Project stats" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Conversations" pending={conversations.isPending}>
          {conversations.data?.length ?? "–"}
        </Stat>
        <Stat label="Created">
          <span title={formatDateTime(project.createdAt)}>
            <RelativeTime value={project.createdAt} />
          </span>
        </Stat>
        <Stat label="Last change">
          <RelativeTime value={project.updatedAt} />
        </Stat>
      </dl>

      <div className="grid gap-5 lg:grid-cols-2">
        <OverviewCard
          title="Recent conversations"
          action={
            <Button asChild variant="ghost" size="sm">
              <Link to="/projects/$projectId/chat" params={{ projectId: project.id }}>
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
              No conversations yet. Start one in the Chat tab.
            </p>
          ) : (
            <ul aria-label="Recent conversations" className="divide-y divide-divider">
              {conversations.data.slice(0, RECENT_LIMIT).map((conversation) => (
                <li key={conversation.id}>
                  <Link
                    to="/projects/$projectId/chat"
                    params={{ projectId: project.id }}
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

      <ArchiveProject project={project} />
    </div>
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
