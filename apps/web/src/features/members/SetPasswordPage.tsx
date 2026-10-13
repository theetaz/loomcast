import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordTokenInfo,
} from "@loomcast/contracts";
import { LoomcastMark } from "@loomcast/ui/brand";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { Label } from "@loomcast/ui/components/label";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { LinkIcon, LoaderCircleIcon, RotateCwIcon, TimerOffIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage, isApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { queryKeys } from "@/lib/query-keys";
import { useTitle } from "@/lib/use-title";
import { readPasswordToken } from "./password-link";

/** No token in the key: the cache only ever holds who the link is for. */
const INSPECT_KEY = ["auth", "password-link"] as const;

interface CapturedLink {
  token: string | null;
  /** Counts the links opened in this tab, so a second link starts a fresh flow. */
  version: number;
}

/**
 * Takes the token out of the URL fragment, then clears the fragment from the
 * address bar and the current history entry before the page is painted. The
 * token stays in memory only. A link opened later in the same tab (a fragment
 * change, which does not reload the page) replaces it.
 */
function usePasswordLink(): CapturedLink {
  const router = useRouter();
  const hash = useLocation({ select: (location) => location.hash });
  const [link, setLink] = useState<CapturedLink>(() => ({
    token: readPasswordToken(router.state.location.hash),
    version: 0,
  }));

  useLayoutEffect(() => {
    if (!hash) return;
    const token = readPasswordToken(hash);
    setLink((current) =>
      current.token === token ? current : { token, version: current.version + 1 },
    );
    const { history } = router;
    history.replace(
      `${history.location.pathname}${history.location.search}`,
      history.location.state,
    );
    history.flush();
  }, [hash, router]);

  return link;
}

/**
 * Where invitation and reset links land: shows who the link is for, then lets
 * them choose a password. Public, outside the signed-in app.
 */
export function SetPasswordPage() {
  const { token, version } = usePasswordLink();
  return <SetPasswordFlow key={version} token={token} version={version} />;
}

function SetPasswordFlow({ token, version }: { token: string | null; version: number }) {
  const [expired, setExpired] = useState(false);
  const info = useQuery({
    queryKey: [...INSPECT_KEY, version],
    queryFn: ({ signal }) => {
      if (!token) throw new Error("No token");
      return api.request("auth.inspectPasswordToken", { body: { token }, signal });
    },
    enabled: token !== null,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const isInvite = info.data?.purpose === "invite";
  useTitle(isInvite ? "Accept invitation" : "Set your password");

  let body: ReactNode;
  if (!token) {
    body = (
      <Notice
        icon={LinkIcon}
        title="This link is incomplete"
        description="Open the link exactly as you received it. If it still doesn't work, ask the workspace owner for a new one."
      />
    );
  } else if (expired || isApiError(info.error, 404)) {
    body = (
      <Notice
        icon={TimerOffIcon}
        title="This link has expired or was already used"
        description="Each link works once. Invitation links last 7 days and reset links 24 hours. Ask the workspace owner for a new one."
      />
    );
  } else if (info.isError) {
    body = (
      <Notice
        icon={RotateCwIcon}
        title="Couldn't open this link"
        description={errorMessage(info.error)}
        action={
          <Button variant="outline" onClick={() => void info.refetch()} disabled={info.isFetching}>
            <RotateCwIcon aria-hidden="true" />
            {info.isFetching ? "Retrying…" : "Try again"}
          </Button>
        }
      />
    );
  } else if (info.isPending) {
    body = <FormSkeleton />;
  } else {
    body = <SetPasswordForm token={token} info={info.data} onExpired={() => setExpired(true)} />;
  }

  const heading = info.data
    ? isInvite
      ? "Join Loomcast"
      : "Choose a new password"
    : "Set your password";

  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-background px-4 py-10">
      <div className="flex w-full max-w-[380px] flex-col gap-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <LoomcastMark size={40} aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <h1 className="text-display">{heading}</h1>
            {info.data ? (
              <p className="text-control text-muted-foreground text-pretty">
                {isInvite
                  ? "Choose a password to finish setting up your account."
                  : "Your other sessions end once the new password is set."}
              </p>
            ) : null}
          </div>
        </div>
        <div className="rounded-xl bg-card p-5 shadow-card sm:p-6">{body}</div>
        <p className="text-center text-small text-muted-foreground">
          Already have a password?{" "}
          <Link to="/login" className="text-foreground underline-offset-3 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}

function Notice({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof LinkIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 py-2 text-center">
      <span className="flex size-9 items-center justify-center rounded-lg bg-secondary text-muted-foreground shadow-card">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-heading text-foreground">{title}</p>
        <p className="text-control text-muted-foreground text-pretty">{description}</p>
      </div>
      {action}
    </div>
  );
}

function FormSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-4">
      <span role="status" className="sr-only">
        Checking the link…
      </span>
      {["a", "b", "c"].map((key) => (
        <div key={key} className="grid gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
      <Skeleton className="mt-1 h-9 w-full" />
    </div>
  );
}

type FieldErrors = { password?: string; confirm?: string };

function validate(password: string, confirm: string): FieldErrors {
  const errors: FieldErrors = {};
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  } else if (password.length > PASSWORD_MAX_LENGTH) {
    errors.password = `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (!errors.password && confirm !== password) errors.confirm = "The passwords don't match.";
  return errors;
}

/**
 * The password form. It calls the API directly instead of through a mutation,
 * so neither the token nor the password is ever held in the query client.
 */
function SetPasswordForm({
  token,
  info,
  onExpired,
}: {
  token: string;
  info: PasswordTokenInfo;
  onExpired: () => void;
}) {
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const ids = {
    email: `${id}-email`,
    password: `${id}-password`,
    passwordHint: `${id}-password-hint`,
    passwordError: `${id}-password-error`,
    confirm: `${id}-confirm`,
    confirmError: `${id}-confirm-error`,
    formError: `${id}-form-error`,
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const errors = validate(password, confirm);
    setFieldErrors(errors);
    setFormError(null);
    if (errors.password) return passwordRef.current?.focus();
    if (errors.confirm) return confirmRef.current?.focus();

    setPending(true);
    try {
      await api.request("auth.setPassword", { body: { token, newPassword: password } });
    } catch (error) {
      setPending(false);
      if (isApiError(error, 404)) {
        onExpired();
        return;
      }
      setFormError(errorMessage(error, "Couldn't set the password. Try again."));
      return;
    }
    // The link is spent and every session of this user has ended: start from a clean slate.
    queryClient.removeQueries({ queryKey: INSPECT_KEY });
    queryClient.removeQueries({ queryKey: queryKeys.me });
    toast.success("Password set", { description: "Sign in with your new password." });
    await navigate({ to: "/login", replace: true });
  };

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-describedby={formError ? ids.formError : undefined}
      className="grid gap-4"
    >
      {formError ? (
        <p
          id={ids.formError}
          role="alert"
          className="rounded-md bg-destructive/8 px-3 py-2 text-control text-destructive"
        >
          {formError}
        </p>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor={ids.email}>Email</Label>
        {/* Read-only, but named `username` so password managers save the right account. */}
        <Input
          id={ids.email}
          name="username"
          type="email"
          autoComplete="username"
          value={info.email}
          readOnly
          className="h-9 bg-secondary text-text-2"
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={ids.password}>New password</Label>
        <Input
          ref={passwordRef}
          id={ids.password}
          name="new-password"
          type="password"
          autoComplete="new-password"
          // The form is the only thing on the page.
          autoFocus
          value={password}
          maxLength={PASSWORD_MAX_LENGTH}
          className="h-9"
          aria-invalid={fieldErrors.password ? true : undefined}
          aria-describedby={fieldErrors.password ? ids.passwordError : ids.passwordHint}
          onChange={(event) => {
            setPassword(event.target.value);
            if (fieldErrors.password)
              setFieldErrors((errors) => ({ ...errors, password: undefined }));
          }}
        />
        {fieldErrors.password ? (
          <p id={ids.passwordError} className="text-small text-destructive">
            {fieldErrors.password}
          </p>
        ) : (
          <p id={ids.passwordHint} className="text-small text-muted-foreground">
            At least {PASSWORD_MIN_LENGTH} characters. A few unrelated words work well.
          </p>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={ids.confirm}>Confirm password</Label>
        <Input
          ref={confirmRef}
          id={ids.confirm}
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          maxLength={PASSWORD_MAX_LENGTH}
          className="h-9"
          aria-invalid={fieldErrors.confirm ? true : undefined}
          aria-describedby={fieldErrors.confirm ? ids.confirmError : undefined}
          onChange={(event) => {
            setConfirm(event.target.value);
            if (fieldErrors.confirm)
              setFieldErrors((errors) => ({ ...errors, confirm: undefined }));
          }}
        />
        {fieldErrors.confirm ? (
          <p id={ids.confirmError} className="text-small text-destructive">
            {fieldErrors.confirm}
          </p>
        ) : null}
      </div>

      <Button type="submit" size="lg" className="mt-1 w-full" disabled={pending}>
        {pending ? (
          <>
            <LoaderCircleIcon
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
            Setting password…
          </>
        ) : (
          "Set password"
        )}
      </Button>
      <p className="text-center text-small text-muted-foreground">
        This link expires <time dateTime={info.expiresAt}>{formatDateTime(info.expiresAt)}</time>.
      </p>
    </form>
  );
}
