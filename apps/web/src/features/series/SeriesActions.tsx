import type { Series } from "@loomcast/contracts";
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
import { Button } from "@loomcast/ui/components/button";
import { ArchiveIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { type SeriesStatusAction, useSeriesStatus } from "./queries";

const CONFIRM: Record<
  Exclude<SeriesStatusAction, "resume">,
  { title: (name: string) => string; body: string; action: string; pending: string; done: string }
> = {
  pause: {
    title: (name) => `Pause ${name}?`,
    body: "No new videos are planned for its slots while it is paused. Ideas planned for upcoming slots that haven't been started are archived. Videos already in production carry on.",
    action: "Pause series",
    pending: "Pausing…",
    done: "Series paused",
  },
  archive: {
    title: (name) => `Archive ${name}?`,
    body: "The series stops planning videos and moves to the archived list. Its videos stay in the library.",
    action: "Archive series",
    pending: "Archiving…",
    done: "Series archived",
  },
};

/** Pause or resume, and archive, with a confirmation before anything that cancels plans. */
export function SeriesActions({
  series,
  disabled = false,
}: {
  series: Series;
  disabled?: boolean;
}) {
  const mutation = useSeriesStatus();
  const [confirming, setConfirming] = useState<"pause" | "archive" | null>(null);
  if (series.status === "archived") return null;

  const run = (action: SeriesStatusAction, done: string) =>
    mutation.mutate(
      { series, action },
      {
        onSuccess: (updated) => {
          setConfirming(null);
          toast.success(done, { description: updated.name });
        },
        onError: (error) => {
          if (action === "resume") {
            toast.error("Couldn't resume the series", { description: errorMessage(error) });
          }
        },
      },
    );

  const copy = confirming ? CONFIRM[confirming] : null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {series.status === "paused" ? (
        <Button
          variant="outline"
          disabled={disabled || mutation.isPending}
          onClick={() => run("resume", "Series resumed")}
        >
          <PlayIcon aria-hidden="true" />
          {mutation.isPending && mutation.variables?.action === "resume" ? "Resuming…" : "Resume"}
        </Button>
      ) : (
        <Button
          variant="outline"
          disabled={disabled || mutation.isPending}
          onClick={() => {
            mutation.reset();
            setConfirming("pause");
          }}
        >
          <PauseIcon aria-hidden="true" />
          Pause
        </Button>
      )}
      <Button
        variant="ghost"
        disabled={disabled || mutation.isPending}
        onClick={() => {
          mutation.reset();
          setConfirming("archive");
        }}
      >
        <ArchiveIcon aria-hidden="true" />
        Archive
      </Button>
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (mutation.isPending) return;
          if (!open) setConfirming(null);
        }}
      >
        {copy && confirming ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="min-w-0 break-words">
                {copy.title(series.name)}
              </AlertDialogTitle>
              <AlertDialogDescription>{copy.body}</AlertDialogDescription>
            </AlertDialogHeader>
            {mutation.isError ? (
              <p
                role="alert"
                className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
              >
                {errorMessage(mutation.error, "That didn't work. Try again.")}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant={confirming === "archive" ? "destructive" : "default"}
                disabled={mutation.isPending}
                onClick={(event) => {
                  // Stay open until the request settles.
                  event.preventDefault();
                  run(confirming, copy.done);
                }}
              >
                {mutation.isPending ? copy.pending : copy.action}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
}
