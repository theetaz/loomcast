import {
  allowedActions,
  type ContentAction,
  type ContentItemDetail,
  type ItemAction,
} from "@loomcast/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@loomcast/ui/components/alert-dialog";
import { useState } from "react";
import { toast } from "sonner";
import { useMe } from "@/features/auth/queries";
import { errorMessage } from "@/lib/api";
import { useArchive, useItemAction, useRestore, useReviewItem } from "./queries";

export type Confirming = "reject" | "archive" | null;

/** What the production actions say when they start. */
const ACTION_TOASTS: Record<ContentAction, string> = {
  produce: "Production started",
  write_script: "Writing the script",
  storyboard: "Laying out the storyboard",
  voice: "Recording a new voice take",
  render: "Rendering the video",
  revise: "Revising the script",
};

/**
 * Everything a user can do to the item, gated by the contracts' `allowedActions` for the item's
 * state and current version, with the confirmations Reject and Archive need. The header and the
 * review panel share one instance.
 */
export function useItemDecisions(detail: ContentItemDetail, hasActiveJob: boolean) {
  const me = useMe();
  const { item, currentVersion } = detail;
  const allowed = allowedActions(item.state, "user", me.role, currentVersion);
  const review = useReviewItem(item.id);
  const action = useItemAction(item.id);
  const archive = useArchive(item.id);
  const restore = useRestore(item.id);
  const [confirming, setConfirming] = useState<Confirming>(null);

  const can = (name: ItemAction) => allowed.includes(name);
  const busy = review.isPending || action.isPending || archive.isPending || restore.isPending;

  const start = (name: ContentAction) => {
    if (!can(name) || hasActiveJob) return;
    action.mutate(name === "produce" ? { action: name, through: "review" } : { action: name }, {
      onSuccess: () => toast.success(ACTION_TOASTS[name], { description: item.title }),
      onError: (error) =>
        toast.error("Couldn't start it", {
          description: errorMessage(error, "Try again in a moment."),
        }),
    });
  };

  const approve = () => {
    if (!can("approve")) return;
    review.mutate(
      { versionId: currentVersion.id, decision: "approve" },
      {
        onSuccess: () => toast.success("Approved", { description: item.title }),
        onError: (error) =>
          toast.error("Couldn't approve it", { description: errorMessage(error) }),
      },
    );
  };

  const requestChanges = (comment: string, enqueueRevision: boolean, onDone: () => void) => {
    if (!can("request_changes")) return;
    review.mutate(
      {
        versionId: currentVersion.id,
        decision: "request_changes",
        comment,
        enqueueRevision,
      },
      {
        onSuccess: () => {
          onDone();
          toast.success("Changes requested", {
            description: enqueueRevision
              ? "The producer is revising the script."
              : "It's back at the script stage.",
          });
        },
        onError: (error) =>
          toast.error("Couldn't send the request", { description: errorMessage(error) }),
      },
    );
  };

  return {
    allowed,
    can,
    busy,
    hasActiveJob,
    start,
    approve,
    requestChanges,
    confirmReject: () => {
      review.reset();
      setConfirming("reject");
    },
    confirmArchive: () => {
      archive.reset();
      setConfirming("archive");
    },
    restore: () =>
      restore.mutate(undefined, {
        onSuccess: () => toast.success("Restored as an idea", { description: item.title }),
        onError: (error) =>
          toast.error("Couldn't restore it", { description: errorMessage(error) }),
      }),
    dialogs: (
      <>
        <ConfirmDialog
          open={confirming === "reject"}
          onOpenChange={(open) => !review.isPending && setConfirming(open ? "reject" : null)}
          title={`Reject ${item.title}?`}
          description="It's archived and leaves the pipeline. You can restore it later as an idea."
          confirmLabel="Reject"
          pendingLabel="Rejecting…"
          pending={review.isPending}
          error={
            review.isError ? errorMessage(review.error, "Couldn't reject it. Try again.") : null
          }
          onConfirm={() =>
            review.mutate(
              { versionId: currentVersion.id, decision: "reject" },
              {
                onSuccess: () => {
                  setConfirming(null);
                  toast.success("Rejected", { description: item.title });
                },
              },
            )
          }
        />
        <ConfirmDialog
          open={confirming === "archive"}
          onOpenChange={(open) => !archive.isPending && setConfirming(open ? "archive" : null)}
          title={`Archive ${item.title}?`}
          description="It leaves the pipeline and the library hides it. You can restore it later as an idea."
          confirmLabel="Archive"
          pendingLabel="Archiving…"
          pending={archive.isPending}
          error={
            archive.isError ? errorMessage(archive.error, "Couldn't archive it. Try again.") : null
          }
          onConfirm={() =>
            archive.mutate(undefined, {
              onSuccess: () => {
                setConfirming(null);
                toast.success("Archived", { description: item.title });
              },
            })
          }
        />
      </>
    ),
  };
}

export type ItemDecisions = ReturnType<typeof useItemDecisions>;

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="min-w-0 break-words">{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
          >
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              // Stay open until the request settles.
              event.preventDefault();
              onConfirm();
            }}
          >
            {pending ? pendingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
