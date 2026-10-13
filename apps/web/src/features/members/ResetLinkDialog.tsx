import type { UserSummary } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@loomcast/ui/components/dialog";
import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/api";
import { LinkReveal, type PasswordLinkView } from "./LinkReveal";
import { useResetLink } from "./queries";

export interface ResetLinkDialogProps {
  /** Kept after closing, so the title stays while the dialog fades out. */
  user: UserSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Confirms, then creates a new set-password link for a member and shows it
 * once. Like the invitation link, it lives only in this dialog's state.
 */
export function ResetLinkDialog({ user, open, onOpenChange }: ResetLinkDialogProps) {
  const [revealing, setRevealing] = useState(false);

  // The content unmounts once the dialog has closed, so every opening starts a fresh flow.
  useEffect(() => {
    if (open) setRevealing(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[480px]"
        onInteractOutside={(event) => {
          if (revealing) event.preventDefault();
        }}
      >
        {user ? <ResetFlow user={user} onReveal={() => setRevealing(true)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ResetFlow({ user, onReveal }: { user: UserSummary; onReveal: () => void }) {
  const reset = useResetLink();
  const [link, setLink] = useState<PasswordLinkView | null>(null);

  if (link) return <LinkReveal link={link} />;

  const label = user.name || user.email;
  const create = () => {
    if (reset.isPending) return;
    reset.mutate(user, {
      onSuccess: ({ user: updated, setPasswordUrl, expiresAt }) => {
        setLink({
          purpose: "reset",
          name: updated.name,
          email: updated.email,
          url: setPasswordUrl,
          expiresAt,
        });
        onReveal();
        // Drop the response, link included, from the mutation cache right away.
        reset.reset();
      },
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="min-w-0 break-words">New password link for {label}?</DialogTitle>
        <DialogDescription>
          They choose a new password with it. Any earlier link for them stops working; their current
          password keeps working until they use the new link.
        </DialogDescription>
      </DialogHeader>
      {reset.isError ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {errorMessage(reset.error, "Couldn't create the link. Try again.")}
        </p>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={reset.isPending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="button" disabled={reset.isPending} onClick={create}>
          {reset.isPending ? "Creating link…" : "Create link"}
        </Button>
      </DialogFooter>
    </>
  );
}
