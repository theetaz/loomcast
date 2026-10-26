import {
  CONTENT_PITCH_MAX_LENGTH,
  CONTENT_TITLE_MAX_LENGTH,
  ContentTitleSchema,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import { Textarea } from "@loomcast/ui/components/textarea";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useOptionalWorkspaceParam } from "@/features/workspace/current";
import { workspacesQueryOptions } from "@/features/workspaces/queries";
import { errorMessage } from "@/lib/api";
import { seriesListQueryOptions, useCreateIdea } from "./queries";

const NO_SERIES = "none";

/**
 * Wraps a trigger button. A new idea needs a title; the pitch and series are optional. Inside a
 * workspace the workspace is fixed; in the library the user picks one. The form starts empty every
 * time the dialog opens.
 */
export function NewIdeaDialog({
  workspaceId = null,
  defaultSeriesId = null,
  children,
}: {
  workspaceId?: string | null;
  defaultSeriesId?: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);

  const onOpenChange = (next: boolean) => {
    if (next) setFormKey((key) => key + 1);
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <NewIdeaForm
          key={formKey}
          fixedWorkspaceId={workspaceId}
          defaultSeriesId={defaultSeriesId}
          onCreated={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function NewIdeaForm({
  fixedWorkspaceId,
  defaultSeriesId,
  onCreated,
}: {
  fixedWorkspaceId: string | null;
  defaultSeriesId: string | null;
  onCreated: () => void;
}) {
  const workspaceParam = useOptionalWorkspaceParam();
  const id = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const create = useCreateIdea();

  const workspaces = useQuery({ ...workspacesQueryOptions(), enabled: fixedWorkspaceId === null });
  const activeWorkspaces = (workspaces.data ?? []).filter(
    (workspace) => workspace.status === "active",
  );
  const [chosenWorkspaceId, setChosenWorkspaceId] = useState<string | null>(null);
  const workspaceId = fixedWorkspaceId ?? chosenWorkspaceId ?? activeWorkspaces[0]?.id ?? null;

  const series = useQuery({
    ...seriesListQueryOptions(workspaceId ?? ""),
    enabled: workspaceId !== null,
  });
  const activeSeries = (series.data?.items ?? []).filter((entry) => entry.status !== "archived");

  const [title, setTitle] = useState("");
  const [pitch, setPitch] = useState("");
  const [seriesId, setSeriesId] = useState<string | null>(defaultSeriesId);
  const [titleError, setTitleError] = useState<string | null>(null);
  const chosenSeries =
    seriesId && activeSeries.some((entry) => entry.id === seriesId) ? seriesId : null;

  const ids = {
    title: `${id}-title`,
    titleError: `${id}-title-error`,
    pitch: `${id}-pitch`,
    workspace: `${id}-workspace`,
    series: `${id}-series`,
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending || !workspaceId) return;
    const parsed = ContentTitleSchema.safeParse(title);
    if (!parsed.success) {
      setTitleError("Give the idea a title.");
      titleRef.current?.focus();
      return;
    }
    const trimmedPitch = pitch.trim();
    create.mutate(
      {
        workspaceId,
        body: {
          title: parsed.data,
          ...(trimmedPitch ? { pitch: trimmedPitch } : {}),
          ...(chosenSeries ? { seriesId: chosenSeries } : {}),
        },
      },
      {
        onSuccess: (detail) => {
          onCreated();
          toast.success("Idea added", {
            description: detail.item.title,
            action: {
              label: "Open",
              onClick: () =>
                void navigate({
                  to: "/w/$workspace/content/$itemId",
                  params: {
                    workspace: workspaceParam ?? detail.item.workspaceId,
                    itemId: detail.item.id,
                  },
                }),
            },
          });
        },
      },
    );
  };

  if (fixedWorkspaceId === null && workspaces.isSuccess && activeWorkspaces.length === 0) {
    return (
      <div className="grid gap-4">
        <DialogHeader>
          <DialogTitle>New idea</DialogTitle>
          <DialogDescription>
            Ideas belong to a workspace. Create a workspace first.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button asChild>
            <Link to="/workspaces">Go to workspaces</Link>
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New idea</DialogTitle>
        <DialogDescription>
          Start with a working title. The studio agent turns it into a script when you produce it.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor={ids.title}>Title</Label>
        <Input
          ref={titleRef}
          id={ids.title}
          name="title"
          value={title}
          autoComplete="off"
          maxLength={CONTENT_TITLE_MAX_LENGTH}
          placeholder="Why the borrow checker rejects this loop"
          aria-invalid={titleError ? true : undefined}
          aria-describedby={titleError ? ids.titleError : undefined}
          onChange={(event) => {
            setTitle(event.target.value);
            if (titleError) setTitleError(null);
          }}
        />
        {titleError ? (
          <p id={ids.titleError} className="text-small text-destructive">
            {titleError}
          </p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={ids.pitch}>
          Pitch <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={ids.pitch}
          name="pitch"
          value={pitch}
          rows={3}
          maxLength={CONTENT_PITCH_MAX_LENGTH}
          placeholder="The angle, the hook, or what the viewer should take away"
          className="max-h-40"
          onChange={(event) => setPitch(event.target.value)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {fixedWorkspaceId === null ? (
          <div className="grid gap-1.5">
            <Label htmlFor={ids.workspace}>Workspace</Label>
            <Select
              value={workspaceId ?? undefined}
              onValueChange={(value) => {
                setChosenWorkspaceId(value);
                setSeriesId(null);
              }}
              disabled={activeWorkspaces.length === 0}
            >
              <SelectTrigger id={ids.workspace} className="w-full">
                <SelectValue placeholder="Loading workspaces…" />
              </SelectTrigger>
              <SelectContent>
                {activeWorkspaces.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor={ids.series}>
            Series <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Select
            value={chosenSeries ?? NO_SERIES}
            onValueChange={(value) => setSeriesId(value === NO_SERIES ? null : value)}
            disabled={activeSeries.length === 0}
          >
            <SelectTrigger id={ids.series} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SERIES}>No series</SelectItem>
              {activeSeries.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {create.isError ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {errorMessage(create.error, "Couldn't add the idea. Try again.")}
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={create.isPending || !workspaceId}>
          {create.isPending ? "Adding…" : "Add idea"}
        </Button>
      </DialogFooter>
    </form>
  );
}
