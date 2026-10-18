import { type ApiClient, TOKEN_NAME_MAX_LENGTH } from "@loomcast/contracts";
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
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { channelsQueryOptions } from "@/features/channels/queries";
import { projectsQueryOptions } from "@/features/projects/queries";
import { CopyButton } from "@/features/settings/CopyButton";
import { errorMessage } from "@/lib/api";
import { draftFrom, draftGrants, type GrantDraft, GrantsEditor } from "./GrantsEditor";
import {
  EXPIRY_CHOICES,
  type ExpiryChoice,
  expiryFor,
  useCreateApiClient,
  useUpdateApiClient,
} from "./queries";

/** Where other backends send requests. */
export const API_V1_PATH = "/api/v1";

export interface ApiClientDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edits this client's name and channels; creates a new client when absent. */
  client?: ApiClient | null;
}

/**
 * Creates an API client or edits one. Creating switches the dialog to a
 * one-time reveal of the key; the key lives only in this dialog's state, so it
 * is gone once the dialog closes.
 */
export function ApiClientDialog({ open, onOpenChange, client }: ApiClientDialogProps) {
  const [session, setSession] = useState(0);
  const [revealing, setRevealing] = useState(false);

  const change = (next: boolean) => {
    if (next) {
      setSession((value) => value + 1);
      setRevealing(false);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        className="sm:max-w-[560px]"
        // A stray click outside must not throw away a key that can't be shown again.
        onInteractOutside={(event) => {
          if (revealing) event.preventDefault();
        }}
      >
        <ClientFlow
          key={`${session}-${client?.id ?? "new"}`}
          client={client ?? null}
          onReveal={() => setRevealing(true)}
          onSaved={() => change(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

interface Revealed {
  name: string;
  secret: string;
}

function ClientFlow({
  client,
  onReveal,
  onSaved,
}: {
  client: ApiClient | null;
  onReveal: () => void;
  onSaved: () => void;
}) {
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  if (revealed) return <KeyReveal name={revealed.name} secret={revealed.secret} />;
  return (
    <ClientForm
      client={client}
      onCreated={(next) => {
        setRevealed(next);
        onReveal();
      }}
      onSaved={onSaved}
    />
  );
}

function ClientForm({
  client,
  onCreated,
  onSaved,
}: {
  client: ApiClient | null;
  onCreated: (revealed: Revealed) => void;
  onSaved: () => void;
}) {
  const id = useId();
  const projects = useQuery(projectsQueryOptions());
  const channels = useQuery(channelsQueryOptions());
  const create = useCreateApiClient();
  const update = useUpdateApiClient();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(client?.name ?? "");
  const [projectId, setProjectId] = useState(client?.projectId ?? "");
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [draft, setDraft] = useState<GrantDraft>(() => draftFrom(client?.grants ?? []));
  const [errors, setErrors] = useState<{ name?: string; project?: string; grants?: string }>({});
  const mutation = client ? update : create;
  const pending = mutation.isPending;

  const active = (projects.data ?? []).filter((project) => project.status === "active");
  const channelList = channels.data?.items ?? [];
  const ids = {
    name: `${id}-name`,
    project: `${id}-project`,
    expiry: `${id}-expiry`,
    grants: `${id}-grants`,
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const trimmed = name.trim();
    const grants = draftGrants(channelList, draft);
    const next: typeof errors = {};
    if (!trimmed) next.name = "Name the client after the backend that will use it.";
    if (!client && !projectId) next.project = "Pick the project its posts go into.";
    if (grants.length === 0) next.grants = "Give the client access to at least one channel.";
    setErrors(next);
    if (next.name) {
      nameRef.current?.focus();
      return;
    }
    if (next.project || next.grants) return;

    if (client) {
      update.mutate(
        { id: client.id, body: { name: trimmed, grants } },
        {
          onSuccess: (saved) => {
            toast.success("API client saved", { description: saved.name });
            onSaved();
          },
        },
      );
      return;
    }
    const expiresAt = expiryFor(expiry);
    create.mutate(
      { name: trimmed, projectId, grants, ...(expiresAt === undefined ? {} : { expiresAt }) },
      {
        onSuccess: ({ client: created, secret }) => {
          onCreated({ name: created.name, secret });
          // Drop the response, key included, from the mutation cache right away.
          create.reset();
        },
      },
    );
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{client ? `Edit ${client.name}` : "New API client"}</DialogTitle>
        <DialogDescription>
          {client
            ? "Change its name or the channels it may use. The change applies to its next request."
            : "Another backend uses a client's key to schedule posts on the channels you pick. Create one per backend, so you can revoke it on its own."}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor={ids.name}>Name</Label>
        <Input
          ref={nameRef}
          id={ids.name}
          value={name}
          autoComplete="off"
          maxLength={TOKEN_NAME_MAX_LENGTH}
          placeholder="Blog backend"
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? `${ids.name}-error` : undefined}
          onChange={(event) => {
            setName(event.target.value);
            if (errors.name) setErrors({ ...errors, name: undefined });
          }}
        />
        {errors.name ? (
          <p id={`${ids.name}-error`} className="text-small text-destructive">
            {errors.name}
          </p>
        ) : null}
      </div>

      {client ? null : (
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={ids.project}>Project</Label>
            <Select
              value={projectId}
              onValueChange={(next) => {
                setProjectId(next);
                if (errors.project) setErrors({ ...errors, project: undefined });
              }}
              disabled={!projects.isSuccess}
            >
              <SelectTrigger
                id={ids.project}
                className="w-full"
                aria-invalid={errors.project ? true : undefined}
              >
                <SelectValue placeholder="Pick a project" />
              </SelectTrigger>
              <SelectContent>
                {active.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.project ? (
              <p className="text-small text-destructive">{errors.project}</p>
            ) : (
              <p className="text-small text-muted-foreground">Its posts are created here.</p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.expiry}>Key expires</Label>
            <Select value={expiry} onValueChange={(next) => setExpiry(next as ExpiryChoice)}>
              <SelectTrigger id={ids.expiry} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_CHOICES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <fieldset className="grid min-w-0 gap-1.5">
        <legend className="mb-1.5 font-medium text-small text-text-2">Channels</legend>
        {channels.isPending ? (
          <p className="text-small text-muted-foreground">Loading channels…</p>
        ) : channelList.length === 0 ? (
          <p className="text-small text-muted-foreground">
            Add a channel in Settings → Channels first.
          </p>
        ) : (
          <ScrollArea viewportClassName="max-h-[320px] pr-3">
            <GrantsEditor
              channels={channelList}
              value={draft}
              describedBy={errors.grants ? ids.grants : undefined}
              onChange={(next) => {
                setDraft(next);
                if (errors.grants) setErrors({ ...errors, grants: undefined });
              }}
            />
          </ScrollArea>
        )}
        {errors.grants ? (
          <p id={ids.grants} className="text-small text-destructive">
            {errors.grants}
          </p>
        ) : (
          <p className="text-small text-muted-foreground">
            A channel that needs approval still waits for yours, even with publish access.
          </p>
        )}
      </fieldset>

      {mutation.isError ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {errorMessage(mutation.error, "Couldn't save the API client. Try again.")}
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : client ? "Save changes" : "Create client"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function KeyReveal({ name, secret }: Revealed) {
  const base = `${window.location.origin}${API_V1_PATH}`;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Copy the API key</DialogTitle>
        <DialogDescription>
          <span className="font-medium text-foreground">{name}</span> is ready. Its backend sends
          the key as <code className="font-mono text-mono">Authorization: Bearer …</code> to{" "}
          <code className="font-mono text-mono">{base}</code>.
        </DialogDescription>
      </DialogHeader>

      <div className="flex gap-2.5 rounded-md bg-status-amber/11 px-3 py-2.5 text-small">
        <TriangleAlertIcon
          aria-hidden="true"
          className="mt-px size-3.5 shrink-0 text-status-amber"
        />
        <p className="text-text-2">
          <span className="font-medium text-foreground">This is the only time it's shown.</span>{" "}
          Keep it in the backend's secret store. If you lose it, revoke the client and create a new
          one.
        </p>
      </div>

      <code
        data-testid="api-key-secret"
        className="block select-all break-all rounded-md bg-secondary px-3 py-2.5 font-mono text-mono text-foreground shadow-[0_0_0_1px_var(--border)]"
      >
        {secret}
      </code>

      <DialogFooter>
        <CopyButton value={secret} label="Copy key" showText />
        <DialogClose asChild>
          <Button type="button">Done</Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}
