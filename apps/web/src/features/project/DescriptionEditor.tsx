import { PROJECT_DESCRIPTION_MAX_LENGTH, type Project } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Textarea } from "@loomcast/ui/components/textarea";
import { PencilIcon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { useUpdateProject } from "./queries";

/**
 * The project description with an inline editor. ⌘Enter or Ctrl+Enter saves, Escape cancels, and
 * an empty description clears it.
 */
export function DescriptionEditor({ project }: { project: Project }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const update = useUpdateProject(project);

  const open = () => {
    update.reset();
    setValue(project.description ?? "");
    setEditing(true);
  };

  const close = () => {
    setEditing(false);
    // Return focus to the control that opened the editor.
    queueMicrotask(() => editButtonRef.current?.focus());
  };

  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (update.isPending) return;
    const next = value.trim();
    if (next === (project.description ?? "")) {
      close();
      return;
    }
    update.mutate(
      { description: next === "" ? null : next },
      {
        onSuccess: () => {
          toast.success(next === "" ? "Description cleared" : "Description saved");
          close();
        },
      },
    );
  };

  return (
    <section aria-labelledby={`${id}-title`} className="rounded-lg bg-card shadow-card">
      <div className="flex h-11 items-center gap-3 border-divider border-b pr-2 pl-3.5">
        <h2 id={`${id}-title`} className="font-semibold text-[13px]">
          About
        </h2>
        {editing ? null : (
          <Button
            ref={editButtonRef}
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={open}
            aria-label="Edit description"
          >
            <PencilIcon aria-hidden="true" />
            <span aria-hidden="true">Edit</span>
          </Button>
        )}
      </div>
      {editing ? (
        <form noValidate onSubmit={save} className="flex flex-col gap-2 p-3.5">
          <label htmlFor={`${id}-input`} className="sr-only">
            Description
          </label>
          <Textarea
            id={`${id}-input`}
            autoFocus
            value={value}
            rows={3}
            maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
            placeholder="What the videos are about and who they are for"
            className="max-h-60"
            aria-describedby={`${id}-hint`}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save();
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
          />
          {update.isError ? (
            <p
              role="alert"
              className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
            >
              {errorMessage(update.error, "Couldn't save the description. Try again.")}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <p id={`${id}-hint`} className="mr-auto text-small text-muted-foreground tabular-nums">
              {value.length.toLocaleString("en")} /{" "}
              {PROJECT_DESCRIPTION_MAX_LENGTH.toLocaleString("en")}
              <span className="max-sm:hidden"> · ⌘Enter to save, Esc to cancel</span>
            </p>
            <Button type="button" variant="outline" onClick={close} disabled={update.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      ) : project.description ? (
        <p className="max-w-[72ch] whitespace-pre-line break-words px-3.5 py-3 text-body text-text-2">
          {project.description}
        </p>
      ) : (
        <p className="px-3.5 py-3 text-body text-muted-foreground">
          No description yet. Say what the videos are about and who they are for.
        </p>
      )}
    </section>
  );
}
