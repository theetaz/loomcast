import type { Conversation, JobSummary, Message, Project } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownIcon, MessagesSquareIcon, SparklesIcon } from "lucide-react";
import { type ReactNode, type Ref, useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { devicesQueryOptions, summarizeStudio } from "@/features/devices/queries";
import { api, errorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { Composer } from "./Composer";
import { JobStatusLine } from "./JobStatusLine";
import { describeJob, isTerminal, type StudioAvailability } from "./job-status";
import { DraftMessage, TimelineEntry } from "./MessageItem";
import { buildTimeline, type PendingMessage, type SendVia } from "./messages";
import {
  addConversation,
  cacheJob,
  cacheMessage,
  jobQueryOptions,
  messagesQueryOptions,
  touchConversation,
} from "./queries";
import { useStickToBottom } from "./scroll";
import { type ConversationStore, type StreamDraft, useConversationStore } from "./store";

/** The job that answers the latest message: tracked in this tab, or read from the messages. */
export function latestJobId(
  messages: readonly Pick<Message, "jobId">[],
  tracked: string | undefined,
): string | undefined {
  if (tracked) return tracked;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const jobId = messages[index]?.jobId;
    if (jobId) return jobId;
  }
  return undefined;
}

/** The text that started a job, so Retry can send it again. */
export function promptFor(
  messages: readonly Message[],
  jobId: string,
  remembered: string | undefined,
): string | undefined {
  if (remembered) return remembered;
  const user = messages.filter((message) => message.role === "user");
  return (user.find((message) => message.jobId === jobId) ?? user.at(-1))?.content.text;
}

function useStudioAvailability(conversation: Conversation | undefined): StudioAvailability {
  const devices = useQuery(devicesQueryOptions());
  if (!devices.isSuccess) return "unknown";
  // A conversation that has a producer session waits for the studio agent that holds it.
  if (conversation?.deviceId) {
    const device = devices.data.find((item) => item.id === conversation.deviceId);
    if (device) return device.online ? "online" : "offline";
  }
  return summarizeStudio(devices.data).state;
}

const EMPTY_MESSAGES: Message[] = [];

export interface ConversationThreadProps {
  project: Project;
  /** Undefined until the project has a conversation; the first message starts one. */
  conversation: Conversation | undefined;
  store: ConversationStore;
  onConversationCreated: (conversation: Conversation) => void;
  composerRef: Ref<HTMLTextAreaElement>;
}

/** One conversation: its messages, the streaming reply, the job status and the composer. */
export function ConversationThread({
  project,
  conversation,
  store,
  onConversationCreated,
  composerRef,
}: ConversationThreadProps) {
  const queryClient = useQueryClient();
  const conversationId = conversation?.id ?? "";
  const messagesQuery = useQuery({
    ...messagesQueryOptions(conversationId),
    enabled: Boolean(conversation),
  });
  const messages = messagesQuery.data ?? EMPTY_MESSAGES;

  const allPending = useConversationStore(store, (state) => state.pending);
  const sentVia = useConversationStore(store, (state) => state.sentVia);
  const drafts = useConversationStore(store, (state) => state.drafts);
  const tracked = useConversationStore(store, (state) => state.jobs[conversationId]?.jobId);
  const prompts = useConversationStore(store, (state) => state.prompts);

  const pending = useMemo(
    () => allPending.filter((item) => item.conversationId === conversationId),
    [allPending, conversationId],
  );
  const timeline = useMemo(
    () => buildTimeline(messages, pending, sentVia),
    [messages, pending, sentVia],
  );
  const threadDrafts = useMemo(
    () => Object.values(drafts).filter((draft) => draft.conversationId === conversationId),
    [drafts, conversationId],
  );

  const jobId = latestJobId(messages, tracked);
  const jobQuery = useQuery({ ...jobQueryOptions(jobId ?? ""), enabled: Boolean(jobId) });
  const job = jobQuery.data;
  const activity = useConversationStore(store, (state) =>
    jobId ? state.activity[jobId] : undefined,
  );
  const studio = useStudioAvailability(conversation);
  const view = job
    ? describeJob(job, {
        studio,
        activity: activity ?? null,
        streaming: threadDrafts.some((draft) => draft.jobId === job.id),
      })
    : null;

  // Scrolling -------------------------------------------------------------

  const scrollRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { pinned, scrollToBottom } = useStickToBottom(
    scrollRef,
    contentRef,
    `${conversationId}:${messagesQuery.isSuccess}`,
  );

  // Sending ---------------------------------------------------------------

  const [sending, setSending] = useState(false);

  const post = useCallback(
    async (message: PendingMessage) => {
      setSending(true);
      let targetId = message.conversationId;
      try {
        if (!targetId) {
          const created = await api.request("conversations.create", {
            params: { projectId: project.id },
            body: {},
          });
          addConversation(queryClient, created);
          store.updatePending(message.clientMessageId, { conversationId: created.id });
          onConversationCreated(created);
          targetId = created.id;
        }
        const result = await api.request("messages.post", {
          params: { id: targetId },
          body: { text: message.text, clientMessageId: message.clientMessageId },
        });
        cacheMessage(queryClient, result.message);
        cacheJob(queryClient, result.job);
        store.trackJob(result.job, message.text);
        touchConversation(queryClient, project.id, targetId, result.message.createdAt);
        if (queryClient.getQueryData(queryKeys.conversations.messages(targetId))) {
          store.removePending(message.clientMessageId);
        }
      } catch (error) {
        store.updatePending(message.clientMessageId, { status: "failed", error });
      } finally {
        setSending(false);
      }
    },
    [project.id, queryClient, store, onConversationCreated],
  );

  const send = useCallback(
    (text: string, via: SendVia) => {
      store.clearDrafts(conversationId);
      const message: PendingMessage = {
        clientMessageId: crypto.randomUUID(),
        conversationId,
        text,
        status: "sending",
        createdAt: new Date().toISOString(),
        via,
      };
      store.addPending(message);
      scrollToBottom();
      void post(message);
    },
    [conversationId, post, store, scrollToBottom],
  );

  /** A message the API never stored goes again with the same id, so it cannot be stored twice. */
  const resend = useCallback(
    (message: PendingMessage) => {
      store.updatePending(message.clientMessageId, { status: "sending", error: undefined });
      void post({ ...message, status: "sending" });
    },
    [post, store],
  );

  /** A reply that failed or was cancelled: the same words, as a new message. */
  function retryJob() {
    if (!job) return;
    const text = promptFor(messages, job.id, prompts[job.id]);
    if (text) send(text, "pointer");
  }

  const cancel = useMutation({
    mutationFn: (id: string) => api.request("jobs.cancel", { params: { id } }),
    onSuccess: (updated) => cacheJob(queryClient, updated),
    onError: (error) =>
      toast.error("Couldn't cancel the reply", { description: errorMessage(error) }),
  });

  // Rendering -------------------------------------------------------------

  const empty = timeline.length === 0 && threadDrafts.length === 0;
  let body: ReactNode;
  if (conversation && messagesQuery.isPending) {
    body = <MessagesSkeleton />;
  } else if (conversation && messagesQuery.isError && messages.length === 0) {
    body = (
      <ErrorState
        size="compact"
        title="Couldn't load the messages"
        error={messagesQuery.error}
        onRetry={() => void messagesQuery.refetch()}
        retrying={messagesQuery.isFetching}
        className="flex-1"
      />
    );
  } else if (empty) {
    body = conversation ? (
      <EmptyState
        size="compact"
        icon={MessagesSquareIcon}
        title="No messages yet"
        description="Ask the studio agent anything about this project. Replies stream in here."
        className="flex-1"
      />
    ) : (
      <EmptyState
        size="compact"
        icon={SparklesIcon}
        title="Start a conversation"
        description="Chat with the studio agent about this project: research a topic, draft a script or plan a video."
        className="flex-1"
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <section
          ref={scrollRef}
          aria-label="Messages"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the scrolling region must be reachable from the keyboard.
          tabIndex={0}
          className="absolute inset-0 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <div ref={contentRef} className="flex min-h-full flex-col">
            {body ?? (
              <ol className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-5 md:px-6">
                {timeline.map((item) => (
                  <li key={item.key}>
                    <TimelineEntry item={item} onRetry={resend} />
                  </li>
                ))}
                {threadDrafts.map((draft) => (
                  <li key={`draft:${draft.jobId}`}>
                    <Draft draft={draft} stopped={isStopped(draft, job)} />
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
        <JumpToLatest visible={!pinned && !body} onClick={scrollToBottom} />
      </div>
      <div className="mx-auto w-full max-w-[760px] px-3 pb-3 md:px-5">
        <Composer
          draftKey={conversationId || "new"}
          onSend={send}
          sending={sending}
          textareaRef={composerRef}
          status={
            view && !view.hidden ? (
              <JobStatusLine
                view={view}
                onCancel={() => job && cancel.mutate(job.id)}
                cancelling={cancel.isPending}
                onRetry={retryJob}
                retryDisabled={sending}
              />
            ) : view?.label === "Done" ? (
              <p role="status" className="sr-only">
                The studio agent replied.
              </p>
            ) : null
          }
        />
      </div>
    </div>
  );
}

/** Text streamed for a reply that failed or was cancelled stays, marked as stopped. */
function isStopped(draft: StreamDraft, job: JobSummary | undefined): boolean {
  return Boolean(
    job && job.id === draft.jobId && isTerminal(job.status) && job.status !== "succeeded",
  );
}

function Draft({ draft, stopped }: { draft: StreamDraft; stopped: boolean }) {
  return <DraftMessage text={draft.text} stopped={stopped} />;
}

function JumpToLatest({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  return (
    <div
      inert={!visible}
      aria-hidden={!visible || undefined}
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-3 flex justify-center transition-[opacity,translate] ease-out motion-reduce:translate-y-0",
        visible
          ? "translate-y-0 opacity-100 duration-menu-in"
          : "translate-y-1 opacity-0 duration-menu-out",
      )}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onClick}
        className="pointer-events-auto rounded-full shadow-pop"
      >
        <ArrowDownIcon aria-hidden="true" />
        Jump to latest
      </Button>
    </div>
  );
}

export function MessagesSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-5 md:px-6"
    >
      <Skeleton className="ml-auto h-9 w-2/5 rounded-lg" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-3/5" />
      </div>
      <Skeleton className="ml-auto h-9 w-1/3 rounded-lg" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-10/12" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}
