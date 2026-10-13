import type { ContentItem } from "@loomcast/contracts";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState } from "react";
import { ErrorState } from "@/components/ErrorState";
import { MessagesSkeleton } from "@/features/conversation/MessagesSkeleton";
import { createConversationStore } from "@/features/conversation/store";
import { useConversationLive } from "@/features/conversation/use-conversation-live";
import { useProject } from "@/features/project/queries";
import { itemConversationQueryOptions } from "./queries";

// The thread brings the markdown renderer; it loads with the chat, not with the page.
const ConversationThread = lazy(() =>
  import("@/features/conversation/ConversationThread").then((module) => ({
    default: module.ConversationThread,
  })),
);

const noop = () => {};

/**
 * The item's own conversation with the producer (`content.conversation`), in the same thread,
 * streaming and composer as the project chat.
 */
export function ItemChat({ item }: { item: ContentItem }) {
  const conversation = useQuery(itemConversationQueryOptions(item.id));
  const project = useProject(item.projectId);
  const [store] = useState(createConversationStore);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useConversationLive(item.projectId, store, conversation.data?.id);

  const failed = conversation.isError ? conversation : project.isError ? project : null;

  return (
    <section
      aria-labelledby="item-chat-heading"
      className="flex h-[520px] flex-col overflow-hidden rounded-lg bg-card shadow-card max-lg:h-[480px]"
    >
      <div className="flex h-11 shrink-0 items-center border-divider border-b px-4">
        <h2 id="item-chat-heading" className="font-semibold text-[13px]">
          Producer chat
        </h2>
        <span className="ml-auto truncate pl-3 text-small text-muted-foreground">
          About this video
        </span>
      </div>
      {failed ? (
        <ErrorState
          size="compact"
          className="flex-1"
          title="Couldn't open the chat"
          error={failed.error}
          onRetry={() => void failed.refetch()}
          retrying={failed.isFetching}
        />
      ) : conversation.data && project.data ? (
        <Suspense fallback={<MessagesSkeleton />}>
          <ConversationThread
            project={project.data}
            conversation={conversation.data}
            store={store}
            onConversationCreated={noop}
            composerRef={composerRef}
          />
        </Suspense>
      ) : (
        <MessagesSkeleton />
      )}
    </section>
  );
}
