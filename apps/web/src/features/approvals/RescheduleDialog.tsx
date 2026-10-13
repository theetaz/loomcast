import { MIN_SCHEDULE_LEAD_MS, type ScheduledPost } from "@loomcast/contracts";
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
import { toast } from "sonner";
import { platformLabel } from "@/features/channels/platforms";
import { errorMessage } from "@/lib/api";
import { useRescheduleMissed } from "./queries";

const pad = (value: number) => String(value).padStart(2, "0");

/** `YYYY-MM-DDTHH:mm` in the browser's time zone, for a `datetime-local` input. */
export function toLocalInput(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A `datetime-local` value read in the browser's time zone; NaN when it isn't one. */
export function fromLocalInput(value: string): number {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? new Date(value).getTime() : Number.NaN;
}

/** The suggested new time: the first full hour at least an hour away. */
export function suggestedTime(now: number): number {
  const date = new Date(now + 2 * 60 * 60_000);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

/** Picks a new time for a missed post, in the browser's time zone. */
export function RescheduleDialog({
  post,
  channelName,
  onClose,
}: {
  /** The post to move; null when closed. */
  post: ScheduledPost | null;
  channelName: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={post !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-[420px]">
        {post ? (
          <RescheduleForm key={post.id} post={post} channelName={channelName} onDone={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RescheduleForm({
  post,
  channelName,
  onDone,
}: {
  post: ScheduledPost;
  channelName: string | null;
  onDone: () => void;
}) {
  const id = useId();
  const reschedule = useRescheduleMissed();
  const [value, setValue] = useState(() => toLocalInput(suggestedTime(Date.now())));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const where = channelName
    ? `${channelName} (${platformLabel(post.platform)})`
    : platformLabel(post.platform);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reschedule.isPending) return;
    const time = fromLocalInput(value);
    if (Number.isNaN(time)) {
      setFieldError("Pick a date and time.");
      return;
    }
    if (time < Date.now() + MIN_SCHEDULE_LEAD_MS) {
      setFieldError("Pick a time at least two minutes ahead.");
      return;
    }
    reschedule.mutate(
      { post, scheduledAt: new Date(time).toISOString() },
      {
        onSuccess: (moved) => {
          onDone();
          toast.success("Post rescheduled", {
            description: `${moved.item.title} on ${where}`,
          });
        },
      },
    );
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Reschedule post</DialogTitle>
        <DialogDescription className="break-words">
          {post.item.title} on {where}. It waits for its new time again, and publishes once the
          video is approved.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-at`}>New time</Label>
        <Input
          id={`${id}-at`}
          type="datetime-local"
          value={value}
          min={toLocalInput(Date.now() + MIN_SCHEDULE_LEAD_MS)}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${id}-error` : `${id}-zone`}
          onChange={(event) => {
            setValue(event.target.value);
            if (fieldError) setFieldError(null);
          }}
        />
        {fieldError ? (
          <p id={`${id}-error`} className="text-small text-destructive">
            {fieldError}
          </p>
        ) : (
          <p id={`${id}-zone`} className="text-small text-muted-foreground">
            In your time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
          </p>
        )}
      </div>
      {reschedule.error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {errorMessage(reschedule.error, "Couldn't reschedule the post. Try again.")}
        </p>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={reschedule.isPending}>
          {reschedule.isPending ? "Rescheduling…" : "Reschedule"}
        </Button>
      </DialogFooter>
    </form>
  );
}
