import { EmailSchema, USER_NAME_MAX_LENGTH } from "@loomcast/contracts";
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
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { errorMessage, isApiError } from "@/lib/api";
import { LinkReveal, type PasswordLinkView } from "./LinkReveal";
import { useInviteMember } from "./queries";

/**
 * Wraps a trigger button. Inviting switches the dialog to a one-time reveal of
 * the set-password link. The link lives only in this dialog's state, so it is
 * gone once the dialog closes; opening it again starts a new, empty form.
 */
export function InviteDialog({ children }: { children: ReactNode }) {
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
        // A stray click outside must not throw away a link that can't be shown again.
        onInteractOutside={(event) => {
          if (revealing) event.preventDefault();
        }}
      >
        {/* Content unmounts once the dialog has closed, taking the link with it. */}
        <InviteFlow key={session} onReveal={() => setRevealing(true)} />
      </DialogContent>
    </Dialog>
  );
}

function InviteFlow({ onReveal }: { onReveal: () => void }) {
  const [link, setLink] = useState<PasswordLinkView | null>(null);

  if (link) return <LinkReveal link={link} />;

  return (
    <InviteForm
      onInvited={(next) => {
        setLink(next);
        onReveal();
      }}
    />
  );
}

function InviteForm({ onInvited }: { onInvited: (link: PasswordLinkView) => void }) {
  const id = useId();
  const invite = useInviteMember();
  const emailRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const ids = {
    email: `${id}-email`,
    emailError: `${id}-email-error`,
    name: `${id}-name`,
    nameError: `${id}-name-error`,
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (invite.isPending) return;
    const parsedEmail = EmailSchema.safeParse(email);
    const trimmedName = name.trim();
    const nextEmailError = parsedEmail.success
      ? null
      : "Enter an email address, like ana@example.com.";
    const nextNameError = trimmedName ? null : "Add their name, as teammates will see it.";
    setEmailError(nextEmailError);
    setNameError(nextNameError);
    if (nextEmailError || nextNameError || !parsedEmail.success) {
      (nextEmailError ? emailRef : nameRef).current?.focus();
      return;
    }
    invite.mutate(
      { email: parsedEmail.data, name: trimmedName, role: "admin" },
      {
        onSuccess: ({ user, setPasswordUrl, expiresAt }) => {
          onInvited({
            purpose: "invite",
            name: user.name,
            email: user.email,
            url: setPasswordUrl,
            expiresAt,
          });
          // Drop the response, link included, from the mutation cache right away.
          invite.reset();
        },
        onError: (error) => {
          if (isApiError(error, 409)) {
            setEmailError("Someone with this email is already a member.");
            emailRef.current?.focus();
          }
        },
      },
    );
  };

  const conflict = isApiError(invite.error, 409);

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Invite a member</DialogTitle>
        <DialogDescription>
          You get a link to send them. They choose a password with it and join as an admin: they can
          work on every project, but can't manage members.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor={ids.email}>Email</Label>
        <Input
          ref={emailRef}
          id={ids.email}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          value={email}
          maxLength={254}
          placeholder="ana@example.com"
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? ids.emailError : undefined}
          onChange={(event) => {
            setEmail(event.target.value);
            if (emailError) setEmailError(null);
          }}
        />
        {emailError ? (
          <p id={ids.emailError} className="text-small text-destructive">
            {emailError}
          </p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={ids.name}>Name</Label>
        <Input
          ref={nameRef}
          id={ids.name}
          name="name"
          autoComplete="off"
          value={name}
          maxLength={USER_NAME_MAX_LENGTH}
          placeholder="Ana Silva"
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

      {invite.isError && !conflict ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {errorMessage(invite.error, "Couldn't create the invitation. Try again.")}
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={invite.isPending}>
          {invite.isPending ? "Creating link…" : "Create invitation"}
        </Button>
      </DialogFooter>
    </form>
  );
}
