import { CHANNEL_NAME_MAX_LENGTH, type Channel, ChannelNameSchema } from "@loomcast/contracts";
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
import { Input } from "@loomcast/ui/components/input";
import { Label } from "@loomcast/ui/components/label";
import { type FormEvent, useId, useState } from "react";
import { errorMessage } from "@/lib/api";
import { platformLabel } from "./platforms";
import { useUpdateChannel } from "./queries";

/** Renames a channel. The name is Loomcast's own; the account on the platform keeps its name. */
export function RenameChannelDialog({
  channel,
  onClose,
}: {
  /** The channel to rename; null when closed. */
  channel: Channel | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={channel !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-[400px]">
        {channel ? <RenameForm key={channel.id} channel={channel} onDone={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({ channel, onDone }: { channel: Channel; onDone: () => void }) {
  const id = useId();
  const update = useUpdateChannel();
  const [name, setName] = useState(channel.displayName);
  const [nameError, setNameError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (update.isPending) return;
    const parsed = ChannelNameSchema.safeParse(name);
    if (!parsed.success) {
      setNameError("Give the channel a name.");
      return;
    }
    if (parsed.data === channel.displayName) {
      onDone();
      return;
    }
    update.mutate({ channel, change: { displayName: parsed.data } }, { onSuccess: onDone });
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Rename channel</DialogTitle>
        <DialogDescription>
          How this {platformLabel(channel.platform)} channel is called in Loomcast.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          value={name}
          autoComplete="off"
          maxLength={CHANNEL_NAME_MAX_LENGTH}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${id}-name-error` : undefined}
          onChange={(event) => {
            setName(event.target.value);
            if (nameError) setNameError(null);
          }}
        />
        {nameError ? (
          <p id={`${id}-name-error`} className="text-small text-destructive">
            {nameError}
          </p>
        ) : null}
      </div>
      {update.error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {errorMessage(update.error, "Couldn't rename the channel. Try again.")}
        </p>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
