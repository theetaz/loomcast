import type { Project } from "@loomcast/contracts";
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
import { useArchiveProject } from "./queries";

/** Archives the project after a confirmation. Archived projects say when they were archived. */
export function ArchiveProject({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const archive = useArchiveProject(project);

  if (project.status === "archived") {
    return (
      <section
        aria-label="Archive"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-card px-3.5 py-3 shadow-card"
      >
        <ArchiveIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <p className="text-body text-text-2">
          Archived
          {project.archivedAt ? (
            <>
              {" "}
              <RelativeTime value={project.archivedAt} format="relative" />
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
        <h2 className="font-semibold text-[13px]">Archive this project</h2>
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
          Archive project
        </Button>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="min-w-0 break-words">
              Archive {project.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The project moves to the archived list. Its conversations and knowledge stay readable,
              but no new conversations or messages can be added.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {archive.isError ? (
            <p
              role="alert"
              className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
            >
              {errorMessage(archive.error, "Couldn't archive the project. Try again.")}
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
                    toast.success("Project archived", { description: project.name });
                  },
                });
              }}
            >
              {archive.isPending ? "Archiving…" : "Archive project"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
