import type { CreateKbEntry, KbEntryDetail, UpdateKbEntry } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { api } from "@/lib/api";
import { cacheKbEntry, kbEntryQueryOptions } from "./queries";

/** "⌘S" on Apple platforms, "Ctrl+S" elsewhere. */
export function saveShortcutLabel(): string {
  const platform = globalThis.navigator?.platform ?? "";
  return /mac|iphone|ipad/i.test(platform) ? "⌘S" : "Ctrl+S";
}

export function useCreateKbEntry(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateKbEntry) => api.request("kb.create", { params: { projectId }, body }),
    onSuccess: (entry) => cacheKbEntry(queryClient, entry),
  });
}

export function useUpdateKbEntry(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateKbEntry) => api.request("kb.update", { params: { id }, body }),
    onSuccess: (entry) => cacheKbEntry(queryClient, entry),
  });
}

/** The entry as the server has it now, bypassing the cache. */
export function useFetchLatestEntry() {
  const queryClient = useQueryClient();
  return (id: string): Promise<KbEntryDetail> =>
    queryClient.fetchQuery({ ...kbEntryQueryOptions(id), staleTime: 0 });
}

/**
 * Shown when a save hit `409 conflict` (`kind="conflict"`), or when a live event says the entry
 * changed while it was open (`kind="stale"`). Reload takes the stored version; Overwrite saves
 * this one over it.
 */
export function ConflictBanner({
  kind,
  busy,
  onReload,
  onOverwrite,
}: {
  kind: "conflict" | "stale";
  busy: boolean;
  onReload: () => void;
  onOverwrite: () => void;
}) {
  return (
    <div
      role={kind === "conflict" ? "alert" : "status"}
      className="flex flex-col gap-2.5 rounded-lg bg-status-amber/11 px-3.5 py-3 sm:flex-row sm:items-center"
    >
      <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-status-amber" />
      <p className="min-w-0 flex-1 text-body text-foreground">
        {kind === "conflict"
          ? "This entry changed elsewhere since you opened it. Reload to see the latest version, or overwrite it with yours."
          : "This entry changed elsewhere while you were editing. Reload to see it, or keep editing and overwrite it when you save."}
      </p>
      <div className="flex shrink-0 gap-1.5">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onReload}>
          <RefreshCwIcon aria-hidden="true" />
          Reload
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onOverwrite}>
          Overwrite
        </Button>
      </div>
    </div>
  );
}

/** A form-level error from a failed save, other than a conflict. */
export function SaveError({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive">
      {message}
    </p>
  );
}
