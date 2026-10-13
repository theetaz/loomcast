import type { PasswordTokenPurpose } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@loomcast/ui/components/dialog";
import { TriangleAlertIcon } from "lucide-react";
import { CopyButton } from "@/features/settings/CopyButton";
import { formatDateTime } from "@/lib/format";

/** A set-password link as the API hands it over, once. */
export interface PasswordLinkView {
  purpose: PasswordTokenPurpose;
  name: string;
  email: string;
  url: string;
  expiresAt: string;
}

const VALID_FOR: Record<PasswordTokenPurpose, string> = {
  invite: "7 days",
  reset: "24 hours",
};

/**
 * The one-time reveal of an invitation or reset link. The link lives only in
 * the dialog's state: closing the dialog drops it for good.
 */
export function LinkReveal({ link }: { link: PasswordLinkView }) {
  const isInvite = link.purpose === "invite";
  return (
    <>
      <DialogHeader>
        <DialogTitle>{isInvite ? "Send the invitation link" : "Send the reset link"}</DialogTitle>
        <DialogDescription>
          Send this link to{" "}
          <span className="font-medium text-foreground [overflow-wrap:anywhere]">{link.name}</span>{" "}
          <span className="[overflow-wrap:anywhere]">({link.email})</span>
          {isInvite
            ? ". It opens a page where they choose a password and join the workspace."
            : ". It opens a page where they choose a new password; their other sessions end."}
        </DialogDescription>
      </DialogHeader>

      <div className="flex gap-2.5 rounded-md bg-status-amber/11 px-3 py-2.5 text-small">
        <TriangleAlertIcon
          aria-hidden="true"
          className="mt-px size-3.5 shrink-0 text-status-amber"
        />
        <p className="text-text-2">
          <span className="font-medium text-foreground">This is the only time it's shown.</span>{" "}
          Anyone with the link can set the password, so send it privately. If it gets lost, create a
          new one.
        </p>
      </div>

      <div className="grid gap-1.5">
        <code
          data-testid="password-link"
          className="block select-all rounded-md bg-secondary px-3 py-2.5 font-mono text-mono text-foreground shadow-[0_0_0_1px_var(--border)] [overflow-wrap:anywhere]"
        >
          {link.url}
        </code>
        <p className="text-small text-muted-foreground">
          Works once. Expires{" "}
          <time dateTime={link.expiresAt} className="text-text-2">
            {formatDateTime(link.expiresAt)}
          </time>{" "}
          ({VALID_FOR[link.purpose]} from now).
        </p>
      </div>

      <DialogFooter>
        <CopyButton value={link.url} label="Copy link" showText />
        <DialogClose asChild>
          <Button type="button">Done</Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}
