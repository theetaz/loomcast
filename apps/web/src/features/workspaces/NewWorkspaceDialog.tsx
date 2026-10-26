import {
  slugify,
  WORKSPACE_DESCRIPTION_MAX_LENGTH,
  WORKSPACE_NAME_MAX_LENGTH,
  WorkspaceNameSchema,
} from "@loomcast/contracts";
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
import { Textarea } from "@loomcast/ui/components/textarea";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { useCreateWorkspace } from "./queries";

export interface NewWorkspaceDialogProps {
  /** The trigger button. Leave it out when the dialog is opened from elsewhere. */
  children?: ReactNode;
  /** Controls the dialog from outside, as the command palette does. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Wraps a trigger button, or is controlled. The form starts empty every time the dialog opens. */
export function NewWorkspaceDialog({
  children,
  open: controlled,
  onOpenChange,
}: NewWorkspaceDialogProps) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = (next: boolean) => {
    if (controlled === undefined) setUncontrolled(next);
    onOpenChange?.(next);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {children ? <DialogTrigger asChild>{children}</DialogTrigger> : null}
      <DialogContent className="sm:max-w-[460px]">
        {/* The content unmounts once the dialog has closed, so each opening starts empty. */}
        <NewWorkspaceForm onCreated={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function NewWorkspaceForm({ onCreated }: { onCreated: () => void }) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const create = useCreateWorkspace();
  const navigate = useNavigate();

  const slug = slugify(name);
  const ids = {
    name: `${id}-name`,
    nameError: `${id}-name-error`,
    slug: `${id}-slug`,
    description: `${id}-description`,
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) return;
    const parsed = WorkspaceNameSchema.safeParse(name);
    if (!parsed.success) {
      setNameError("Give the workspace a name.");
      nameRef.current?.focus();
      return;
    }
    const trimmedDescription = description.trim();
    create.mutate(
      { name: parsed.data, description: trimmedDescription || undefined },
      {
        onSuccess: (workspace) => {
          onCreated();
          toast.success("Workspace created", { description: workspace.name });
          void navigate({ to: "/w/$workspace", params: { workspace: workspace.slug } });
        },
      },
    );
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New workspace</DialogTitle>
        <DialogDescription>
          A workspace holds one brand: its channels, series, videos, research and conversations.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor={ids.name}>Name</Label>
        <Input
          ref={nameRef}
          id={ids.name}
          name="name"
          value={name}
          autoComplete="off"
          maxLength={WORKSPACE_NAME_MAX_LENGTH}
          placeholder="Rust in 60 seconds"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${ids.nameError} ${ids.slug}` : ids.slug}
          onChange={(event) => {
            setName(event.target.value);
            if (nameError) setNameError(null);
          }}
        />
        {nameError ? (
          <p id={ids.nameError} className="text-small text-destructive">
            {nameError}
          </p>
        ) : null}
        <p
          id={ids.slug}
          className="flex min-w-0 items-center gap-1.5 text-small text-muted-foreground"
        >
          <span className="shrink-0">Slug</span>
          {slug ? (
            <code
              data-testid="slug-preview"
              className="min-w-0 truncate rounded-sm bg-secondary px-1.5 py-px font-mono text-mono text-foreground shadow-[0_0_0_1px_var(--border)]"
            >
              {slug}
            </code>
          ) : (
            <span data-testid="slug-preview">picked when you create the workspace</span>
          )}
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={ids.description}>
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={ids.description}
          name="description"
          value={description}
          rows={3}
          maxLength={WORKSPACE_DESCRIPTION_MAX_LENGTH}
          placeholder="What the videos are about and who they are for"
          className="max-h-40"
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      {create.isError ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {errorMessage(create.error, "Couldn't create the workspace. Try again.")}
        </p>
      ) : null}

      <DialogFooter>
        <p className="mr-auto hidden self-center text-small text-muted-foreground sm:block">
          Slugs never change.
        </p>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create workspace"}
        </Button>
      </DialogFooter>
    </form>
  );
}
