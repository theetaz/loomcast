import { useQueryClient } from "@tanstack/react-query";
import { applyChannel } from "@/features/channels/queries";
import { useLiveEvent } from "@/lib/live";
import { applyPost, calendarKeys, updateCalendars } from "./queries";

/**
 * Keeps the calendar current with posts and channels changed anywhere: the scheduler, the
 * publisher, MCP clients or another tab. Mounted by the calendar page.
 */
export function useCalendarLive() {
  const queryClient = useQueryClient();
  useLiveEvent("post.updated", (event) => {
    applyPost(queryClient, event.payload.post);
    // Approved items gain or lose open posts; the slot picker asks again when it next opens.
    void queryClient.invalidateQueries({
      queryKey: [...calendarKeys.all, "approved"],
      refetchType: "none",
    });
  });
  useLiveEvent("channel.updated", (event) => applyChannel(queryClient, event.payload.channel));
  // A post shows its item's title and state.
  useLiveEvent("content.item.updated", (event) => {
    const { id, title, state, posterAssetId } = event.payload.item;
    updateCalendars(queryClient, (data) =>
      data.posts.some((post) => post.itemId === id)
        ? {
            ...data,
            posts: data.posts.map((post) =>
              post.itemId === id ? { ...post, item: { title, state, posterAssetId } } : post,
            ),
          }
        : data,
    );
  });
}
