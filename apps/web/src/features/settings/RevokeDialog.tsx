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
import type { ReactNode } from "react";
import { errorMessage } from "@/lib/api";

export interface RevokeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
}

/**
 * Confirmation before revoking a device or token. It stays open while the
 * request runs and shows failures inline; the caller closes it on success.
 */
export function RevokeDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
  pending,
  error,
  onConfirm,
}: RevokeDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
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
            {errorMessage(error, "Couldn't revoke it. Try again.")}
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
