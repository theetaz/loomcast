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
import { Input } from "@loomcast/ui/components/input";
import { Label } from "@loomcast/ui/components/label";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, CircleAlertIcon, XIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { channelLabel, platformLabel } from "./platforms";
import { publisherStatusQueryOptions } from "./queries";
import {
  confirmsGoLive,
  GO_LIVE_PHRASE,
  type GoLivePrecondition,
  goLivePreconditions,
} from "./rules";

export interface GoLiveDialogProps {
  /** The channel about to leave dry-run; null when closed. */
  channel: Channel | null;
  onCancel: () => void;
  onConfirm: (channel: Channel) => void;
}

/**
 * The confirmation before a channel leaves dry-run: what the server checks, and the words
 * `publish live` typed out. Nothing goes live until both are satisfied; the server checks again
 * and answers `409 dry_run_locked` if anything changed meanwhile.
 */
export function GoLiveDialog({ channel, onCancel, onConfirm }: GoLiveDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // The last channel stays in the dialog while it closes, so the content doesn't empty mid-exit.
  const [shown, setShown] = useState(channel);
  if (channel !== null && channel !== shown) setShown(channel);

  return (
    <AlertDialog open={channel !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        {shown ? (
          <GoLiveForm
            key={shown.id}
            channel={shown}
            inputRef={inputRef}
            onConfirm={(confirmed) => {
              if (channel !== null) onConfirm(confirmed);
            }}
          />
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function GoLiveForm({
  channel,
  inputRef,
  onConfirm,
}: {
  channel: Channel;
  inputRef: RefObject<HTMLInputElement | null>;
  onConfirm: (channel: Channel) => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const { data: publisher } = useQuery(publisherStatusQueryOptions());
  const conditions = goLivePreconditions(channel, publisher);
  const blocked =
    channel.liveBlocker !== null ||
    conditions.some((condition) => !condition.met && !condition.advisory);
  const confirmed = confirmsGoLive(typed);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (confirmed && !blocked) onConfirm(channel);
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <AlertDialogHeader>
        <AlertDialogTitle className="min-w-0 break-words">
          Publish live on {channelLabel(channel)}?
        </AlertDialogTitle>
        <AlertDialogDescription>
          Posts on this channel will be published to {platformLabel(channel.platform)} for real.
          Posts queued while it dry-ran stay dry-run.
        </AlertDialogDescription>
      </AlertDialogHeader>

      <section aria-labelledby={`${id}-checks`} className="grid gap-1.5">
        <h3 id={`${id}-checks`} className="font-medium text-small text-text-2">
          What the server checks
        </h3>
        <ul className="grid gap-1 rounded-md bg-accent/50 px-3 py-2.5">
          {conditions.map((condition) => (
            <Condition key={condition.id} condition={condition} />
          ))}
        </ul>
      </section>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-phrase`}>
          Type <span className="font-mono text-[12px]">{GO_LIVE_PHRASE}</span> to confirm
        </Label>
        <Input
          ref={inputRef}
          id={`${id}-phrase`}
          value={typed}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={GO_LIVE_PHRASE}
          disabled={blocked}
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>

      <AlertDialogFooter>
        <AlertDialogCancel type="button">Keep dry-run</AlertDialogCancel>
        <Button type="submit" variant="destructive" disabled={!confirmed || blocked}>
          Publish live
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

function Condition({ condition }: { condition: GoLivePrecondition }) {
  const Icon = condition.met ? CheckIcon : condition.advisory ? CircleAlertIcon : XIcon;
  return (
    <li
      data-met={condition.met}
      className={cn(
        "flex items-start gap-2 text-small",
        condition.met
          ? "text-text-2"
          : condition.advisory
            ? "text-status-amber"
            : "text-status-red",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 size-3.5 shrink-0", condition.met && "text-status-green")}
      />
      <span className="min-w-0 text-pretty">
        {condition.label}
        <span className="sr-only">{condition.met ? ": yes" : ": no"}</span>
      </span>
    </li>
  );
}
