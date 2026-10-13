import { Button } from "@loomcast/ui/components/button";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { errorMessage, isApiError } from "@/lib/api";

/** Whether a failed `versions.edit` lost the race to another version (`409 conflict`). */
export function isEditConflict(error: unknown): boolean {
  return isApiError(error, 409) && error.code === "conflict";
}

/**
 * Shown when a save hit `409 conflict` (`kind="conflict"`), or when a newer version arrived while
 * editing (`kind="stale"`). Reload drops the edits and opens the newest version; "Save on top"
 * keeps them and saves them over it.
 */
export function EditConflictBanner({
  kind,
  busy,
  onReload,
  onOverwrite,
}: {
  kind: "conflict" | "stale";
  busy: boolean;
  onReload: () => void;
  onOverwrite?: () => void;
}) {
  return (
    <div
      role={kind === "conflict" ? "alert" : "status"}
      className="flex flex-col gap-2.5 rounded-lg bg-status-amber/11 px-3.5 py-3 sm:flex-row sm:items-center"
    >
      <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-status-amber" />
      <p className="min-w-0 flex-1 text-body text-foreground">
        {kind === "conflict"
          ? "A newer version of this video was saved while you were editing, so yours wasn't. Reload to see it, or save your edits on top of it."
          : "A newer version of this video arrived while you were editing. Reload to see it, or keep editing and save on top of it."}
      </p>
      <div className="flex shrink-0 gap-1.5">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onReload}>
          <RefreshCwIcon aria-hidden="true" />
          Reload
        </Button>
        {onOverwrite ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onOverwrite}>
            Save on top
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** A failed save other than a conflict. */
export function EditError({ error }: { error: unknown }) {
  return (
    <p role="alert" className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive">
      {errorMessage(error, "Couldn't save it. Try again.")}
    </p>
  );
}

/** Why editing is off, when it is. */
export function editBlockedReason({
  canEdit,
  viewingCurrent,
  hasActiveJob,
}: {
  canEdit: boolean;
  viewingCurrent: boolean;
  hasActiveJob: boolean;
}): string | null {
  if (!viewingCurrent) return "Edits start from the current version.";
  if (hasActiveJob) return "Wait for the running job to finish, or cancel it.";
  if (!canEdit) return "This video can't be edited in its current state.";
  return null;
}
