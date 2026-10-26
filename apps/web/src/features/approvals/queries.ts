import type {
  ApprovalItem,
  ApprovalsInbox,
  ContentItem,
  CreateReviewRequest,
  ScheduledPost,
} from "@loomcast/contracts";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { applyPost } from "@/features/calendar/queries";
import { upsertContentItem } from "@/features/library/queries";
import { applyToQueues } from "@/features/review-queue/queries";
import { api, errorMessage, isApiError } from "@/lib/api";
import { useLiveEvent, useLiveReconnect } from "@/lib/live";

export const approvalsKeys = {
  all: ["approvals"] as const,
  inbox: (workspaceId: string | null) => ["approvals", "inbox", workspaceId ?? "all"] as const,
};

export function approvalsQueryOptions(workspaceId: string | null) {
  return queryOptions({
    queryKey: approvalsKeys.inbox(workspaceId),
    queryFn: ({ signal }) =>
      api.request("approvals.inbox", {
        query: workspaceId ? { workspaceId } : {},
        signal,
      }),
    // Decisions taken elsewhere while the inbox was closed show when it opens again.
    staleTime: 0,
  });
}

/**
 * The API's order: the nearest deadline first, items without one last, then the longest waiting
 * (`updatedAt`), then by id.
 */
export function compareApprovals(a: ApprovalItem, b: ApprovalItem): number {
  if (a.deadlineAt !== b.deadlineAt) {
    if (a.deadlineAt === null) return 1;
    if (b.deadlineAt === null) return -1;
    return a.deadlineAt.localeCompare(b.deadlineAt);
  }
  return a.item.updatedAt.localeCompare(b.item.updatedAt) || a.item.id.localeCompare(b.item.id);
}

/** Missed posts, the most recent first. */
export function compareMissed(a: ScheduledPost, b: ScheduledPost): number {
  return b.scheduledAt.localeCompare(a.scheduledAt) || b.id.localeCompare(a.id);
}

function updateInboxes(
  queryClient: QueryClient,
  update: (inbox: ApprovalsInbox) => ApprovalsInbox,
) {
  for (const [queryKey, data] of queryClient.getQueriesData<ApprovalsInbox>({
    queryKey: approvalsKeys.all,
  })) {
    if (!data) continue;
    const next = update(data);
    if (next !== data) queryClient.setQueryData(queryKey, next);
  }
}

function invalidateInboxes(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: approvalsKeys.all });
}

/** Drops an item that left review from every loaded inbox. */
export function removeApprovalItem(queryClient: QueryClient, itemId: string) {
  updateInboxes(queryClient, (inbox) =>
    inbox.items.some((entry) => entry.item.id === itemId)
      ? { ...inbox, items: inbox.items.filter((entry) => entry.item.id !== itemId) }
      : inbox,
  );
}

/**
 * An item from the API or a live event: still in review, it replaces the cached copy; out of
 * review, it leaves. An item new to review refetches, since only the server knows its deadline.
 */
export function applyApprovalItem(queryClient: QueryClient, item: ContentItem) {
  let unknown = false;
  updateInboxes(queryClient, (inbox) => {
    const cached = inbox.items.find((entry) => entry.item.id === item.id);
    if (!cached) {
      if (item.state === "review") unknown = true;
      return inbox;
    }
    if (cached.item.updatedAt > item.updatedAt) return inbox;
    if (item.state !== "review") {
      return { ...inbox, items: inbox.items.filter((entry) => entry.item.id !== item.id) };
    }
    return {
      ...inbox,
      items: inbox.items.map((entry) => (entry.item.id === item.id ? { ...entry, item } : entry)),
    };
  });
  if (unknown) invalidateInboxes(queryClient);
}

/**
 * A changed post: a missed post leaves the missed list once it moves on; a newly missed post, or
 * a post of an item waiting for approval (its deadline may move), refetches.
 */
export function applyApprovalPost(queryClient: QueryClient, post: ScheduledPost) {
  let refetch = false;
  updateInboxes(queryClient, (inbox) => {
    const listed = inbox.missed.find((entry) => entry.id === post.id);
    if (listed && post.status !== "missed") {
      return { ...inbox, missed: inbox.missed.filter((entry) => entry.id !== post.id) };
    }
    if (listed) {
      return {
        ...inbox,
        missed: inbox.missed.map((entry) => (entry.id === post.id ? post : entry)),
      };
    }
    if (post.status === "missed" || inbox.items.some((entry) => entry.item.id === post.itemId)) {
      refetch = true;
    }
    return inbox;
  });
  if (refetch) invalidateInboxes(queryClient);
}

/** Keeps the inbox current with item and post events while it is open. */
export function useApprovalsLive() {
  const queryClient = useQueryClient();
  useLiveEvent("content.item.created", (event) =>
    applyApprovalItem(queryClient, event.payload.item),
  );
  useLiveEvent("content.item.updated", (event) =>
    applyApprovalItem(queryClient, event.payload.item),
  );
  useLiveEvent("post.updated", (event) => applyApprovalPost(queryClient, event.payload.post));
  useLiveReconnect(() => invalidateInboxes(queryClient));
}

export type Decision =
  | { item: ContentItem; decision: "approve" }
  | { item: ContentItem; decision: "request_changes"; comment: string; enqueueRevision: boolean };

function reviewBody(input: Decision): CreateReviewRequest {
  return input.decision === "approve"
    ? { versionId: input.item.currentVersionId, decision: "approve" }
    : {
        versionId: input.item.currentVersionId,
        decision: "request_changes",
        comment: input.comment,
        enqueueRevision: input.enqueueRevision,
      };
}

/**
 * Approves an item or asks for changes, on the version the inbox shows. The item leaves every
 * inbox and the review queue; a `409` (a newer version, or decided elsewhere) refetches.
 *
 * The outcome toasts live here, not in the row's `mutate` callbacks: the row unmounts as soon as
 * its item leaves the inbox (from this cache update or from the live stream, which can arrive
 * before the response), and an unmounted row's callbacks never run.
 */
export function useDecide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Decision) =>
      api.request("reviews.create", { params: { id: input.item.id }, body: reviewBody(input) }),
    onSuccess: ({ item }, input) => {
      toast.success(input.decision === "approve" ? "Approved" : "Changes requested", {
        description: input.item.title,
      });
      applyApprovalItem(queryClient, item);
      upsertContentItem(queryClient, item);
      applyToQueues(queryClient, item);
      // A request for changes may have queued a revision.
      void queryClient.invalidateQueries({ queryKey: ["content", "detail", item.id] });
    },
    onError: (error, input) => {
      toast.error(input.decision === "approve" ? "Couldn't approve" : "Couldn't request changes", {
        description: isApiError(error, 409)
          ? "The video changed since the inbox loaded. It now shows the latest version."
          : errorMessage(error),
      });
      if (isApiError(error, 409) || isApiError(error, 404)) invalidateInboxes(queryClient);
    },
  });
}

export interface RescheduleMissedInput {
  post: ScheduledPost;
  scheduledAt: string;
}

/** Gives a missed post a new time. It waits again (queued, or planned until approved). */
export function useRescheduleMissed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ post, scheduledAt }: RescheduleMissedInput) =>
      api.request("scheduledPosts.reschedule", {
        params: { id: post.id },
        body: { scheduledAt, expectedUpdatedAt: post.updatedAt },
      }),
    onSuccess: (post) => {
      applyApprovalPost(queryClient, post);
      applyPost(queryClient, post);
    },
    onError: (error) => {
      if (isApiError(error, 409) || isApiError(error, 404)) invalidateInboxes(queryClient);
    },
  });
}
