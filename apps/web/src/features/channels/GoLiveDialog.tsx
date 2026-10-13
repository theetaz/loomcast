import type { Channel } from "@loomcast/contracts";
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
import { channelLabel } from "./platforms";

export interface GoLiveDialogProps {
  /** The channel about to leave dry-run; null when closed. */
  channel: Channel | null;
  onCancel: () => void;
  onConfirm: (channel: Channel) => void;
}

/**
 * The confirmation before a channel leaves dry-run. Only channels the server lets go live
 * (`liveBlocker` null) get here. The go-live flow replaces this dialog with a typed confirmation
 * and the server's preconditions; the channel row only depends on these props.
 */
export function GoLiveDialog({ channel, onCancel, onConfirm }: GoLiveDialogProps) {
  return (
    <AlertDialog open={channel !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="min-w-0 break-words">
            Publish live on {channel ? channelLabel(channel) : "this channel"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Posts on this channel will be published to the platform for real. Posts queued while it
            dry-ran stay dry-run.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep dry-run</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (channel) onConfirm(channel);
            }}
          >
            Publish live
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
