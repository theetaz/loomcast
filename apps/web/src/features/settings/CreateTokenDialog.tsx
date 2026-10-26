import { MCP_TOKEN_SCOPES, type McpTokenScope, TOKEN_NAME_MAX_LENGTH } from "@loomcast/contracts";
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
import { Switch } from "@loomcast/ui/components/switch";
import { TriangleAlertIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { useMe } from "@/features/auth/queries";
import { errorMessage } from "@/lib/api";
import { CopyButton } from "./CopyButton";
import { SCOPE_DESCRIPTIONS, SCOPE_LABELS, useCreateToken } from "./queries";

/**
 * Wraps a trigger button. Creating a token switches the dialog to a one-time
 * reveal of the secret. The secret lives only in this dialog's state, so it is
 * gone once the dialog closes; opening it again starts a new, empty form.
 */
export function CreateTokenDialog({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const [revealing, setRevealing] = useState(false);

  const onOpenChange = (next: boolean) => {
    if (next) {
      setSession((value) => value + 1);
      setRevealing(false);
    }
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        className="sm:max-w-[480px]"
        // A stray click outside must not throw away a secret that can't be shown again.
        onInteractOutside={(event) => {
          if (revealing) event.preventDefault();
        }}
      >
        <CreateTokenFlow key={session} onReveal={() => setRevealing(true)} />
      </DialogContent>
    </Dialog>
  );
}

interface Revealed {
  name: string;
  secret: string;
}

function CreateTokenFlow({ onReveal }: { onReveal: () => void }) {
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  if (revealed) return <TokenReveal name={revealed.name} secret={revealed.secret} />;

  return (
    <CreateTokenForm
      onCreated={(next) => {
        setRevealed(next);
        onReveal();
      }}
    />
  );
}

function CreateTokenForm({ onCreated }: { onCreated: (revealed: Revealed) => void }) {
  const id = useId();
  const me = useMe();
  const create = useCreateToken();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ReadonlySet<McpTokenScope>>(() => new Set(["mcp:read"]));
  const [nameError, setNameError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);

  const available = MCP_TOKEN_SCOPES.filter(
    (scope) => scope !== "mcp:admin" || me.role === "owner",
  );
  const ids = {
    name: `${id}-name`,
    nameError: `${id}-name-error`,
    scopeError: `${id}-scope-error`,
  };

  const toggle = (scope: McpTokenScope, on: boolean) => {
    setScopes((current) => {
      const next = new Set(current);
      if (on) next.add(scope);
      else next.delete(scope);
      return next;
    });
    if (on) setScopeError(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) return;
    const trimmed = name.trim();
    const chosen = available.filter((scope) => scopes.has(scope));
    if (!trimmed) {
      setNameError("Name the token after the tool that will use it.");
      nameRef.current?.focus();
      return;
    }
    if (chosen.length === 0) {
      setScopeError("Pick at least one scope.");
      return;
    }
    create.mutate(
      { name: trimmed, scopes: chosen },
      {
        onSuccess: ({ token, secret }) => {
          onCreated({ name: token.name, secret });
          // Drop the response, secret included, from the mutation cache right away.
          create.reset();
        },
      },
    );
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New access token</DialogTitle>
        <DialogDescription>
          Tools use a token to reach your workspaces over MCP. Create one per tool, so you can
          revoke it on its own.
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
          maxLength={TOKEN_NAME_MAX_LENGTH}
          placeholder="Editor on my laptop"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? ids.nameError : undefined}
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
      </div>

      <fieldset
        className="grid min-w-0 gap-1.5"
        aria-describedby={scopeError ? ids.scopeError : undefined}
      >
        <legend className="mb-1.5 font-medium text-small text-text-2">Scopes</legend>
        <div className="overflow-hidden rounded-md bg-card shadow-card">
          {available.map((scope) => {
            const switchId = `${id}-${scope}`;
            return (
              <div
                key={scope}
                className="flex items-center gap-3 border-divider border-t px-3 py-2.5 first:border-t-0"
              >
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <Label htmlFor={switchId} className="text-control text-foreground">
                    {SCOPE_LABELS[scope]}
                    <code className="font-mono font-normal text-[10.5px] text-muted-foreground">
                      {scope}
                    </code>
                  </Label>
                  <p id={`${switchId}-description`} className="text-small text-muted-foreground">
                    {SCOPE_DESCRIPTIONS[scope]}
                  </p>
                </div>
                <Switch
                  id={switchId}
                  checked={scopes.has(scope)}
                  aria-describedby={`${switchId}-description`}
                  onCheckedChange={(on) => toggle(scope, on)}
                />
              </div>
            );
          })}
        </div>
        {scopeError ? (
          <p id={ids.scopeError} className="text-small text-destructive">
            {scopeError}
          </p>
        ) : null}
      </fieldset>

      {create.isError ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {errorMessage(create.error, "Couldn't create the token. Try again.")}
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create token"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function TokenReveal({ name, secret }: Revealed) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Copy your new token</DialogTitle>
        <DialogDescription>
          <span className="font-medium text-foreground">{name}</span> is ready. Paste the token into
          the tool's MCP settings.
        </DialogDescription>
      </DialogHeader>

      <div className="flex gap-2.5 rounded-md bg-status-amber/11 px-3 py-2.5 text-small">
        <TriangleAlertIcon
          aria-hidden="true"
          className="mt-px size-3.5 shrink-0 text-status-amber"
        />
        <p className="text-text-2">
          <span className="font-medium text-foreground">This is the only time it's shown.</span>{" "}
          Loomcast keeps just enough to recognise it. If you lose it, revoke it and create a new
          one.
        </p>
      </div>

      <code
        data-testid="token-secret"
        className="block select-all break-all rounded-md bg-secondary px-3 py-2.5 font-mono text-mono text-foreground shadow-[0_0_0_1px_var(--border)]"
      >
        {secret}
      </code>

      <DialogFooter>
        <CopyButton value={secret} label="Copy token" showText />
        <DialogClose asChild>
          <Button type="button">Done</Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}
