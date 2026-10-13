import type { Channel } from "@loomcast/contracts";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@loomcast/ui/components/alert-dialog";
import { Button } from "@loomcast/ui/components/button";
import { useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { channelLabel, platformLabel } from "./platforms";
import { useDisconnectChannel } from "./queries";

/**
 * Confirms disconnecting a channel. The server deletes the stored access and puts the channel
 * back in dry-run; the channel, its series and its posts stay, and signing in with the same
 * account later reconnects it.
 */
export function DisconnectChannelDialog({
  channel,
  onClose,
}: {
  /** The channel to disconnect; null when closed. */
  channel: Channel | null;
  onClose: () => void;
}) {
  const disconnect = useDisconnectChannel();
  const [shown, setShown] = useState(channel);
  if (channel !== null && channel !== shown) setShown(channel);
  const label = shown ? channelLabel(shown) : "this channel";

  const confirm = () => {
    if (!channel || disconnect.isPending) return;
    disconnect.mutate(channel, {
      onSuccess: (updated) => {
        onClose();
        toast.success(`Disconnected ${channelLabel(updated)}`, {
          description: "Its posts only dry-run until the account is connected again.",
        });
      },
    });
  };

  return (
    <AlertDialog
      open={channel !== null}
      onOpenChange={(open) => {
        if (open) return;
        disconnect.reset();
        onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="min-w-0 break-words">Disconnect {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            Loomcast deletes its access to the {shown ? platformLabel(shown.platform) : ""} account
            and switches dry run back on. The channel, its series and its posts stay; open posts
            only dry-run until you connect the account again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {disconnect.error ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
          >
            {errorMessage(disconnect.error, "Couldn't disconnect the channel. Try again.")}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={confirm} disabled={disconnect.isPending}>
            {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
