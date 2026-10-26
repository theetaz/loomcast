import type { Conversation, Workspace } from "@loomcast/contracts";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/ErrorState";
import { api, errorMessage } from "@/lib/api";
import { ConversationColumn, ConversationPicker } from "./ConversationList";
import { MessagesSkeleton } from "./MessagesSkeleton";
import { conversationTitle } from "./messages";
import { addConversation, conversationsQueryOptions } from "./queries";
import { createConversationStore } from "./store";
import { useConversationLive } from "./use-conversation-live";

const workspaceRoute = getRouteApi("/_app/w/$workspace");

// The thread brings the markdown renderer; load it with the panel, not the app.
const ConversationThread = lazy(() =>
  import("./ConversationThread").then((module) => ({ default: module.ConversationThread })),
);

export interface ConversationPanelProps {
  workspace: Workspace;
}

/**
 * The workspace's conversations with the studio agent: a list of conversations
 * (a column on wide screens, a picker on phones) and the open conversation
 * with its streaming reply, job status and composer. The open conversation is
 * in the address (`?conversation=`); without one, the latest is open.
 */
export function ConversationPanel({ workspace }: ConversationPanelProps) {
  const queryClient = useQueryClient();
  const { workspace: workspaceParam } = workspaceRoute.useParams();
  const search = workspaceRoute.useSearch();
  const navigate = workspaceRoute.useNavigate();
  const [store] = useState(createConversationStore);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const query = useQuery(conversationsQueryOptions(workspace.id));
  const conversations = query.data ?? [];
  const selected =
    conversations.find((conversation) => conversation.id === search.conversation) ??
    conversations[0];

  useConversationLive(workspace.id, store, selected?.id);

  const select = useCallback(
    (id: string) => {
      void navigate({ search: (previous) => ({ ...previous, conversation: id }) });
    },
    [navigate],
  );

  const onCreated = useCallback((conversation: Conversation) => select(conversation.id), [select]);

  const create = useMutation({
    mutationFn: () =>
      api.request("conversations.create", { params: { workspaceId: workspace.id }, body: {} }),
    onSuccess: (conversation) => {
      addConversation(queryClient, conversation);
      select(conversation.id);
      composerRef.current?.focus();
    },
    onError: (error) =>
      toast.error("Couldn't start a conversation", { description: errorMessage(error) }),
  });

  const listProps = {
    workspaceParam,
    conversations,
    selectedId: selected?.id,
    onSelect: select,
    onNew: () => create.mutate(),
    creating: create.isPending,
    loading: query.isPending,
  };

  return (
    <section
      aria-label={`Conversations in ${workspace.name}`}
      className="flex min-h-[440px] flex-1 overflow-hidden rounded-lg bg-card shadow-card max-md:min-h-[calc(100svh-7rem)]"
    >
      {query.isError ? (
        <ErrorState
          className="flex-1"
          title="Couldn't load the conversations"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <>
          <ConversationColumn {...listProps} />
          <div className="flex min-w-0 flex-1 flex-col">
            <ConversationPicker {...listProps} />
            <div className="flex h-11 shrink-0 items-center border-divider border-b px-4 max-md:hidden md:px-6">
              {query.isPending ? (
                <Skeleton aria-hidden="true" className="h-3 w-48" />
              ) : (
                <h2 className="min-w-0 truncate font-semibold text-[13px]">
                  {selected ? conversationTitle(selected) : "New conversation"}
                </h2>
              )}
            </div>
            {query.isPending ? (
              <MessagesSkeleton />
            ) : (
              <Suspense fallback={<MessagesSkeleton />}>
                <ConversationThread
                  workspace={workspace}
                  conversation={selected}
                  store={store}
                  onConversationCreated={onCreated}
                  composerRef={composerRef}
                />
              </Suspense>
            )}
          </div>
        </>
      )}
    </section>
  );
}
