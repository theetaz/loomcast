import { useQueryClient } from "@tanstack/react-query";
import { useLiveEvent } from "@/lib/live";
import { patchKbDetail, removeKbEntry, upsertKbEntry } from "./queries";

/**
 * Keeps the knowledge caches current with `kb.entry.*` events from any writer: the web app, MCP
 * clients, producer sessions or the session hook. Mounted once by the project page.
 */
export function useKbLive() {
  const queryClient = useQueryClient();
  useLiveEvent("kb.entry.created", (event) => upsertKbEntry(queryClient, event.payload.entry));
  useLiveEvent("kb.entry.updated", (event) => {
    upsertKbEntry(queryClient, event.payload.entry);
    patchKbDetail(queryClient, event.payload.entry);
  });
  useLiveEvent("kb.entry.deleted", (event) =>
    removeKbEntry(queryClient, event.payload.entryId, event.payload.projectId),
  );
}
