import { CHANNEL_NAME_MAX_LENGTH, ChannelNameSchema, type Platform } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@loomcast/ui/components/dialog";
import { Input } from "@loomcast/ui/components/input";
import { Label } from "@loomcast/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import { Switch } from "@loomcast/ui/components/switch";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { PLATFORM_ORDER, PlatformDot, platformLabel } from "./platforms";
import { useCreateChannel } from "./queries";

/**
 * Wraps a trigger button. A planning channel has a platform and a name but no account: posts can
 * be planned on it and dry-run, and connecting an account later takes it live.
 */
export function AddChannelDialog({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setFormKey((key) => key + 1);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <AddChannelForm key={formKey} onCreated={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function AddChannelForm({ onCreated }: { onCreated: () => void }) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const create = useCreateChannel();
  const [platform, setPlatform] = useState<Platform>("instagram");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [requiresApproval, setRequiresApproval] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) return;
    const parsed = ChannelNameSchema.safeParse(name);
    if (!parsed.success) {
      setNameError("Give the channel a name, such as the account's handle.");
      nameRef.current?.focus();
      return;
    }
    create.mutate(
      { platform, displayName: parsed.data, requiresApproval },
      {
        onSuccess: (channel) => {
          onCreated();
          toast.success("Planning channel added", { description: channel.displayName });
        },
      },
    );
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Add planning channel</DialogTitle>
        <DialogDescription>
          Plan posts for an account before it is connected. A planning channel only dry-runs: it
          records what each post would send and publishes nothing.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-platform`}>Platform</Label>
        <Select value={platform} onValueChange={(value) => setPlatform(value as Platform)}>
          <SelectTrigger id={`${id}-platform`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLATFORM_ORDER.map((entry) => (
              <SelectItem key={entry} value={entry}>
                <PlatformDot platform={entry} />
                {platformLabel(entry)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {platform === "x" ? (
          <p className="text-small text-muted-foreground">
            X channels stay in dry-run until publishing to X is available.
          </p>
        ) : null}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          ref={nameRef}
          id={`${id}-name`}
          value={name}
          autoComplete="off"
          maxLength={CHANNEL_NAME_MAX_LENGTH}
          placeholder="@rustin60"
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
      <div className="flex items-start gap-2.5">
        <Switch
          id={`${id}-approval`}
          checked={requiresApproval}
          onCheckedChange={setRequiresApproval}
          aria-describedby={`${id}-approval-hint`}
          className="mt-0.5"
        />
        <div className="grid gap-0.5">
          <Label htmlFor={`${id}-approval`}>Requires approval</Label>
          <p id={`${id}-approval-hint`} className="text-small text-muted-foreground">
            Every post on this channel waits for a person, whatever the series' publish mode.
          </p>
        </div>
      </div>
      {create.error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {errorMessage(create.error, "Couldn't add the channel. Try again.")}
        </p>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Adding…" : "Add channel"}
        </Button>
      </DialogFooter>
    </form>
  );
}
