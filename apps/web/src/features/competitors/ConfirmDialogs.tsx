import type { Competitor, CompetitorScan } from "@loomcast/contracts";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@loomcast/ui/components/alert-dialog";
import { Button } from "@loomcast/ui/components/button";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { useCancelScan, useDeleteCompetitor } from "./queries";
import { competitorName } from "./status";

/**
 * Wraps a trigger button. Stops following a competitor; its analysed references and reports stay
 * in the knowledge base.
 */
export function DeleteCompetitorDialog({
  competitor,
  onDeleted,
  children,
}: {
  competitor: Competitor;
  onDeleted: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const remove = useDeleteCompetitor();
  const name = competitorName(competitor);

  const confirm = () => {
    if (remove.isPending) return;
    remove.mutate(competitor, {
      onSuccess: () => {
        setOpen(false);
        toast.success(`Stopped following ${name}`, {
          description: "Its analyses and reports stay in the knowledge base.",
        });
        onDeleted();
      },
    });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) remove.reset();
        setOpen(next);
      }}
    >
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="min-w-0 break-words">Remove {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The workspace stops following {name} and its scan history goes. The analysed videos and
            reports stay in the knowledge base, so the studio agent can still use them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.error ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
          >
            {errorMessage(remove.error, "Couldn't remove the competitor. Try again.")}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <Button variant="destructive" onClick={confirm} disabled={remove.isPending}>
            {remove.isPending ? "Removing…" : "Remove competitor"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Wraps a trigger button. Cancels an active scan; finished analyses stay on their references. */
export function CancelScanDialog({
  scan,
  children,
}: {
  scan: CompetitorScan;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const cancel = useCancelScan();

  const confirm = () => {
    if (cancel.isPending) return;
    cancel.mutate(scan, {
      onSuccess: () => {
        setOpen(false);
        toast.success("Scan cancelled", {
          description: "Videos already analysed keep their analyses.",
        });
      },
    });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel.reset();
        setOpen(next);
      }}
    >
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this scan?</AlertDialogTitle>
          <AlertDialogDescription>
            Analyses still waiting or running stop, and no report is written. Videos already
            analysed keep their analyses in the knowledge base.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {cancel.error ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
          >
            {errorMessage(cancel.error, "Couldn't cancel the scan. Try again.")}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep scanning</AlertDialogCancel>
          <Button variant="destructive" onClick={confirm} disabled={cancel.isPending}>
            {cancel.isPending ? "Cancelling…" : "Cancel scan"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
