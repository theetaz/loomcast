import type { Conversation, JobSummary, List, Message } from "@loomcast/contracts";
import { MAX_PAGE_LIMIT } from "@loomcast/contracts";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { laterJob } from "./job-status";
import { sortConversations, sortMessages, upsertMessage } from "./messages";

/** Upper bound on pages read for one conversation: 5,000 messages at 100 a page. */
export const MAX_MESSAGE_PAGES = 50;

export function conversationsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.conversations.list(projectId),
    queryFn: ({ signal }) => api.request("conversations.list", { params: { projectId }, signal }),
    select: (list: List<Conversation>) => sortConversations(list.items),
  });
}

/**
 * The whole conversation, oldest first. Pages are followed to the end and
 * merged by id, so the order the API pages in does not matter.
 */
export function messagesQueryOptions(conversationId: string) {
  return queryOptions({
    queryKey: queryKeys.conversations.messages(conversationId),
    queryFn: async ({ signal }): Promise<Message[]> => {
      const items: Message[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
        const result = await api.request("messages.list", {
          params: { id: conversationId },
          query: { limit: MAX_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
          signal,
        });
        items.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return sortMessages(items);
    },
  });
}

export function jobQueryOptions(jobId: string) {
  return queryOptions({
    queryKey: queryKeys.jobs.detail(jobId),
    queryFn: ({ signal }) => api.request("jobs.get", { params: { id: jobId }, signal }),
  });
}

/** Adds a stored message to its conversation's cache, when that conversation is loaded. */
export function cacheMessage(queryClient: QueryClient, message: Message) {
  queryClient.setQueryData<Message[]>(
    queryKeys.conversations.messages(message.conversationId),
    (messages) => (messages ? upsertMessage(messages, message) : messages),
  );
}

/** Records a job snapshot without moving the cached job backwards. */
export function cacheJob(queryClient: QueryClient, job: JobSummary) {
  queryClient.setQueryData<JobSummary>(queryKeys.jobs.detail(job.id), (current) =>
    laterJob(current, job),
  );
}

/** Moves a conversation to the top of its project's list after a new message. */
export function touchConversation(
  queryClient: QueryClient,
  projectId: string,
  conversationId: string,
  at: string,
) {
  queryClient.setQueryData<List<Conversation>>(queryKeys.conversations.list(projectId), (list) => {
    if (!list?.items.some((item) => item.id === conversationId)) return list;
    return {
      items: list.items.map((item) =>
        item.id === conversationId && (item.lastMessageAt ?? "") < at
          ? { ...item, lastMessageAt: at }
          : item,
      ),
    };
  });
}

export function addConversation(queryClient: QueryClient, conversation: Conversation) {
  queryClient.setQueryData<List<Conversation>>(
    queryKeys.conversations.list(conversation.projectId),
    (list) =>
      list
        ? { items: [conversation, ...list.items.filter((item) => item.id !== conversation.id)] }
        : { items: [conversation] },
  );
  queryClient.setQueryData<Message[]>(
    queryKeys.conversations.messages(conversation.id),
    (messages) => messages ?? [],
  );
}
