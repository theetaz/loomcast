import { useQueryClient } from "@tanstack/react-query";
import { useLiveEvent } from "@/lib/live";
import { contentKeys, upsertContentItem } from "./queries";

/**
 * Keeps the library caches current with `content.*` events from any writer: the web app, MCP
 * clients, producer sessions or the scheduler. Mounted by the library screens.
 */
export function useContentLive() {
  const queryClient = useQueryClient();
  useLiveEvent("content.item.created", (event) =>
    upsertContentItem(queryClient, event.payload.item),
  );
  useLiveEvent("content.item.updated", (event) =>
    upsertContentItem(queryClient, event.payload.item),
  );
  useLiveEvent("content.version.created", (event) => {
    void queryClient.invalidateQueries({
      queryKey: contentKeys.detail(event.payload.version.itemId),
    });
  });
}
