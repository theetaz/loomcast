import { useQueryClient } from "@tanstack/react-query";
import { useLiveEvent, useLiveReconnect } from "@/lib/live";
import { queryKeys } from "@/lib/query-keys";
import { isTerminal } from "./job-status";
import { cacheMessage, touchConversation } from "./queries";
import type { ConversationStore } from "./store";

/**
 * Feeds the live stream into the panel: stored messages into the caches,
 * streamed text and tool activity into the store, and job changes into the
 * tracked job per conversation. The job cache itself is patched by the live
 * client before this runs.
 */
export function useConversationLive(
  projectId: string,
  store: ConversationStore,
  activeConversationId: string | undefined,
) {
  const queryClient = useQueryClient();

  useLiveEvent("conversation.message.created", ({ payload: { message } }) => {
    cacheMessage(queryClient, message);
    touchConversation(queryClient, projectId, message.conversationId, message.createdAt);
    if (message.clientMessageId) store.removePending(message.clientMessageId);
    store.settleDraft(message);
  });

  useLiveEvent("conversation.message.delta", ({ payload }) => {
    store.appendDelta(payload);
  });

  useLiveEvent("job.activity", ({ payload: { jobId, kind, summary } }) => {
    store.setActivity(jobId, { kind, summary });
  });

  useLiveEvent("job.updated", ({ payload: { job } }) => {
    if (job.projectId !== projectId || !job.conversationId) return;
    store.trackJob(job);
    if (!isTerminal(job.status)) return;
    store.clearActivity(job.id);
    if (job.status !== "succeeded") return;
    // The reply is stored by now. Read it back if its event went missing, then
    // drop whatever streamed text is left.
    const conversationId = job.conversationId;
    const messages = queryClient.getQueryData<{ jobId: string | null }[]>(
      queryKeys.conversations.messages(conversationId),
    );
    if (messages?.some((message) => message.jobId === job.id)) {
      store.clearDraft(job.id);
      return;
    }
    void queryClient
      .invalidateQueries({ queryKey: queryKeys.conversations.messages(conversationId) })
      .finally(() => store.clearDraft(job.id));
  });

  // Events sent while the stream was down are gone: read the open conversation again.
  useLiveReconnect(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.list(projectId) });
    if (activeConversationId) {
      void queryClient.refetchQueries({
        queryKey: queryKeys.conversations.messages(activeConversationId),
      });
    }
  });
}
