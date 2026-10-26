import type { Workspace } from "@loomcast/contracts";
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
import { ArchiveIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/RelativeTime";
import { errorMessage } from "@/lib/api";
import { useArchiveWorkspace } from "./queries";

/** Archives the workspace after a confirmation. Archived workspaces say when they were archived. */
export function ArchiveWorkspace({ workspace }: { workspace: Workspace }) {
  const [open, setOpen] = useState(false);
  const archive = useArchiveWorkspace(workspace);

  if (workspace.status === "archived") {
    return (
      <section
        aria-label="Archive"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-card px-3.5 py-3 shadow-card"
      >
        <ArchiveIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <p className="text-body text-text-2">
          Archived
          {workspace.archivedAt ? (
            <>
              {" "}
              <RelativeTime value={workspace.archivedAt} format="relative" />
            </>
          ) : null}
          . Its conversations and knowledge stay readable; it takes no new conversations.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Archive"
      className="flex flex-col gap-3 rounded-lg bg-card px-3.5 py-3 shadow-card sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="font-semibold text-[13px]">Archive this workspace</h2>
        <p className="text-small text-muted-foreground">
          Conversations and knowledge stay readable, but no new conversations can start.
        </p>
      </div>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (archive.isPending) return;
          if (next) archive.reset();
          setOpen(next);
        }}
      >
        <Button
          variant="destructive"
          className="self-start sm:self-auto"
          onClick={() => setOpen(true)}
        >
          <ArchiveIcon aria-hidden="true" />
          Archive workspace
        </Button>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="min-w-0 break-words">
              Archive {workspace.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The workspace moves to the archived list. Its conversations and knowledge stay
              readable, but no new conversations or messages can be added.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {archive.isError ? (
            <p
              role="alert"
              className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
            >
              {errorMessage(archive.error, "Couldn't archive the workspace. Try again.")}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archive.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={archive.isPending}
              onClick={(event) => {
                // Stay open until the request settles.
                event.preventDefault();
                archive.mutate(undefined, {
                  onSuccess: () => {
                    setOpen(false);
                    toast.success("Workspace archived", { description: workspace.name });
                  },
                });
              }}
            >
              {archive.isPending ? "Archiving…" : "Archive workspace"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
