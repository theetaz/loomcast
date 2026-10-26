import {
  type ApprovalItem,
  type Channel,
  REVIEW_COMMENT_MAX_LENGTH,
  type ScheduledPost,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { StatusPill } from "@loomcast/ui/components/StatusPill";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { Textarea } from "@loomcast/ui/components/textarea";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  CheckIcon,
  InboxIcon,
  MessageSquareWarningIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { channelLabel, PlatformDot, platformLabel } from "@/features/channels/platforms";
import { channelsQueryOptions } from "@/features/channels/queries";
import { useSeriesOptions } from "@/features/library/queries";
import { FormatIcon, formatLabel } from "@/features/post-formats/FormatBadge";
import { Poster } from "@/features/review-queue/Poster";
import { useWorkspaceParam } from "@/features/workspace/current";
import { formatDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { type CountdownTone, slotCountdown } from "./countdown";
import {
  approvalsQueryOptions,
  compareApprovals,
  compareMissed,
  type Decision,
  useApprovalsLive,
  useDecide,
} from "./queries";
import { RescheduleDialog } from "./RescheduleDialog";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const TONES: Record<CountdownTone, string> = {
  red: "bg-status-red/11 text-status-red",
  amber: "bg-status-amber/11 text-status-amber",
  blue: "bg-status-blue/11 text-status-blue",
  gray: "bg-status-gray/11 text-status-gray",
};

/**
 * The workspace's videos in review with the time left before their first slot, nearest first,
 * approved or sent back from the row; and posts whose time came before their video was approved,
 * to reschedule.
 */
export function ApprovalsInbox({ workspaceId }: { workspaceId: string }) {
  useApprovalsLive();
  const now = useNow();
  const query = useQuery(approvalsQueryOptions(workspaceId));
  const channels = useQuery(channelsQueryOptions(workspaceId));
  const { byId: seriesById } = useSeriesOptions(workspaceId);
  const [rescheduling, setRescheduling] = useState<ScheduledPost | null>(null);

  const items = useMemo(() => [...(query.data?.items ?? [])].sort(compareApprovals), [query.data]);
  const missed = useMemo(() => [...(query.data?.missed ?? [])].sort(compareMissed), [query.data]);
  const channelById = new Map((channels.data?.items ?? []).map((channel) => [channel.id, channel]));
  const urgent = items.filter(
    (entry) => entry.deadlineAt !== null && Date.parse(entry.deadlineAt) - now < 24 * 60 * 60_000,
  ).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {query.data ? (
          <p className="text-control text-muted-foreground" aria-live="polite">
            {items.length === 1 ? "1 video waiting" : `${items.length} videos waiting`}
            {urgent > 0 ? (
              <span className="text-status-amber"> · {urgent} due within a day</span>
            ) : null}
            {missed.length > 0 ? (
              <span className="text-status-red">
                {" "}
                · {missed.length === 1 ? "1 missed post" : `${missed.length} missed posts`}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      <InboxSection title="Waiting for approval" count={query.data ? items.length : null}>
        {query.isPending ? (
          <RowsSkeleton />
        ) : query.isError ? (
          <ErrorState
            size="compact"
            title="Couldn't load approvals"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : items.length === 0 ? (
          <EmptyState
            size="compact"
            icon={InboxIcon}
            title="Nothing waiting for approval"
            description="Videos land here once they are rendered and wait for a decision before their slot."
          />
        ) : (
          <ol aria-label="Videos waiting for approval">
            {items.map((entry) => (
              <ApprovalRow
                key={entry.item.id}
                entry={entry}
                now={now}
                seriesName={
                  entry.item.seriesId ? (seriesById.get(entry.item.seriesId)?.name ?? null) : null
                }
                channelById={channelById}
              />
            ))}
          </ol>
        )}
      </InboxSection>

      {query.isSuccess ? (
        <InboxSection title="Missed posts" count={missed.length}>
          {missed.length === 0 ? (
            <EmptyState
              size="compact"
              icon={CalendarClockIcon}
              title="No missed posts"
              description="A post is missed when its time comes before its video is approved."
            />
          ) : (
            <ol aria-label="Missed posts">
              {missed.map((post) => (
                <MissedRow
                  key={post.id}
                  post={post}
                  channel={channelById.get(post.channelId)}
                  onReschedule={() => setRescheduling(post)}
                />
              ))}
            </ol>
          )}
        </InboxSection>
      ) : null}

      <RescheduleDialog
        post={rescheduling}
        channelName={
          rescheduling ? (channelById.get(rescheduling.channelId)?.displayName ?? null) : null
        }
        onClose={() => setRescheduling(null)}
      />
    </div>
  );
}

function InboxSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number | null;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-lg bg-card shadow-card">
      <div className="flex h-11 items-center gap-2 border-divider border-b px-3.5">
        <h2 className="font-semibold text-[13px]">{title}</h2>
        {count !== null ? (
          <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function ApprovalRow({
  entry,
  now,
  seriesName,
  channelById,
}: {
  entry: ApprovalItem;
  now: number;
  seriesName: string | null;
  channelById: Map<string, Channel>;
}) {
  const { item, posts, deadlineAt } = entry;
  // One mutation per row, so decisions on several rows run side by side.
  const decide = useDecide();
  const busy = decide.isPending;
  const ids = { comment: useId(), revise: useId(), error: useId() };
  const [requesting, setRequesting] = useState(false);
  const [comment, setComment] = useState("");
  const [revise, setRevise] = useState(true);
  const [missing, setMissing] = useState(false);
  const countdown = slotCountdown(deadlineAt, now);
  const context = seriesName ?? "";
  const workspaceParam = useWorkspaceParam();

  // The outcome toasts come from `useDecide`, so they show even once this row has unmounted.
  const onDecide = (input: Decision, onDone?: () => void) => {
    decide.mutate(input, { onSuccess: () => onDone?.() });
  };

  const sendChanges = () => {
    if (busy) return;
    const text = comment.trim();
    if (!text) {
      setMissing(true);
      return;
    }
    onDecide({ item, decision: "request_changes", comment: text, enqueueRevision: revise }, () =>
      setRequesting(false),
    );
  };

  return (
    <li
      className="border-divider border-t first:border-t-0"
      data-item-id={item.id}
      aria-label={item.title}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5">
        <Poster assetId={item.posterAssetId} format={item.format} className="w-[30px]" />
        <div className="flex min-w-0 flex-1 basis-52 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <Link
              to="/w/$workspace/content/$itemId"
              params={{ workspace: workspaceParam, itemId: item.id }}
              className="truncate rounded-sm font-medium text-body text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.title}
            </Link>
            {item.lastError ? (
              <span title={item.lastError.message} className="inline-flex shrink-0 text-status-red">
                <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
                <span className="sr-only">Last step failed: {item.lastError.message}</span>
              </span>
            ) : null}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-small text-muted-foreground">
            {context ? <span className="min-w-0 truncate">{context}</span> : null}
            {context ? <span aria-hidden="true">·</span> : null}
            <span data-format={item.format}>{formatLabel(item.format)}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-[11px]">v{item.versionNo}</span>
            {posts.length > 0 ? <span aria-hidden="true">·</span> : null}
            {posts.length > 0 ? <PostChannels posts={posts} channelById={channelById} /> : null}
          </span>
        </div>
        <span
          data-tone={countdown.tone}
          data-countdown=""
          title={deadlineAt ? formatDateTime(deadlineAt) : undefined}
          className={cn(
            "inline-flex h-[21px] shrink-0 items-center whitespace-nowrap rounded-full px-[7px] font-medium text-[11.5px] tabular-nums",
            TONES[countdown.tone],
          )}
        >
          <span aria-hidden="true">{countdown.label}</span>
          <span className="sr-only">{countdown.description}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1.5 max-sm:w-full max-sm:pl-[42px]">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onDecide({ item, decision: "approve" })}
            aria-label={`Approve ${item.title}`}
          >
            <CheckIcon aria-hidden="true" />
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-expanded={requesting}
            aria-label={`Request changes to ${item.title}`}
            onClick={() => {
              setRequesting((open) => !open);
              setMissing(false);
            }}
          >
            <MessageSquareWarningIcon aria-hidden="true" />
            <span className="max-sm:hidden">Request changes</span>
            <span className="sm:hidden">Changes</span>
          </Button>
        </div>
      </div>
      {requesting ? (
        <form
          aria-label={`Request changes to ${item.title}`}
          className="flex flex-col gap-2 px-3.5 pb-3 sm:pl-[56px]"
          onSubmit={(event) => {
            event.preventDefault();
            sendChanges();
          }}
        >
          <Textarea
            id={ids.comment}
            // Opened by the user to type into straight away.
            autoFocus
            value={comment}
            rows={2}
            maxLength={REVIEW_COMMENT_MAX_LENGTH}
            placeholder="What should change? The hook runs long."
            aria-label="What should change?"
            aria-invalid={missing || undefined}
            aria-describedby={missing ? ids.error : undefined}
            onChange={(event) => {
              setComment(event.target.value);
              if (missing && event.target.value.trim()) setMissing(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                sendChanges();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setRequesting(false);
              }
            }}
          />
          {missing ? (
            <p id={ids.error} role="alert" className="text-small text-destructive">
              Say what should change.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label htmlFor={ids.revise} className="flex items-center gap-2 text-control">
              <input
                id={ids.revise}
                type="checkbox"
                checked={revise}
                onChange={(event) => setRevise(event.target.checked)}
                className="size-3.5 rounded-sm accent-primary"
              />
              Ask the producer to revise
            </label>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="text-small text-text-4 max-sm:hidden">
                {isMac ? "⌘Enter" : "Ctrl+Enter"}
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setRequesting(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="outline" size="sm" disabled={busy}>
                Send
              </Button>
            </span>
          </div>
        </form>
      ) : null}
    </li>
  );
}

/** The channels an item's open posts go to, as dots; the names are in the accessible text. */
function PostChannels({
  posts,
  channelById,
}: {
  posts: readonly ScheduledPost[];
  channelById: Map<string, Channel>;
}) {
  const names = posts.map((post) => {
    const channel = channelById.get(post.channelId);
    return channel ? channelLabel(channel) : platformLabel(post.platform);
  });
  return (
    <span className="inline-flex items-center gap-1" title={names.join(", ")}>
      {posts.map((post) => (
        <PlatformDot key={post.id} platform={post.platform} />
      ))}
      <span className="sr-only">Posts on {names.join(", ")}</span>
      <span aria-hidden="true" className="max-sm:hidden">
        {posts.length === 1 ? names[0] : `${posts.length} channels`}
      </span>
    </span>
  );
}

function MissedRow({
  post,
  channel,
  onReschedule,
}: {
  post: ScheduledPost;
  channel: Channel | undefined;
  onReschedule: () => void;
}) {
  const workspaceParam = useWorkspaceParam();
  const where = channel ? channelLabel(channel) : platformLabel(post.platform);
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-divider border-t px-3.5 py-2.5 first:border-t-0"
      data-post-id={post.id}
      aria-label={`${post.item.title} on ${where}`}
    >
      <PlatformDot platform={post.platform} className="ml-1" />
      <div className="flex min-w-0 flex-1 basis-52 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <FormatIcon format={post.item.format} label />
          <Link
            to="/w/$workspace/content/$itemId"
            params={{ workspace: workspaceParam, itemId: post.itemId }}
            className="truncate rounded-sm font-medium text-body text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {post.item.title}
          </Link>
        </span>
        <span className="truncate text-small text-muted-foreground">
          {where} · was due{" "}
          <time dateTime={post.scheduledAt} className="tabular-nums">
            {formatDateTime(post.scheduledAt)}
          </time>
        </span>
      </div>
      <StatusPill kind="post" status={post.status} />
      <Button
        size="sm"
        variant="outline"
        onClick={onReschedule}
        aria-label={`Reschedule ${post.item.title} on ${where}`}
      >
        <CalendarClockIcon aria-hidden="true" />
        Reschedule
      </Button>
    </li>
  );
}

function RowsSkeleton() {
  return (
    <div aria-hidden="true">
      {["54%", "41%", "63%"].map((width) => (
        <div
          key={width}
          className="flex h-[74px] items-center gap-3 border-divider border-t px-3.5 first:border-t-0"
        >
          <Skeleton className="h-[53px] w-[30px] rounded-[5px]" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3" style={{ width }} />
            <Skeleton className="h-2.5 w-32" />
          </div>
          <Skeleton className="h-[18px] w-14 rounded-full" />
          <Skeleton className="h-7 w-40 rounded-md max-sm:hidden" />
        </div>
      ))}
    </div>
  );
}
