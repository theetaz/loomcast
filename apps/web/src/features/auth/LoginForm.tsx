import { EmailSchema } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { Label } from "@loomcast/ui/components/label";
import { LoaderCircleIcon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { errorMessage, isApiError } from "@/lib/api";
import { useLogin } from "./queries";

type FieldErrors = { email?: string; password?: string };

function validate(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!email.trim()) errors.email = "Enter your email address.";
  else if (!EmailSchema.safeParse(email).success) errors.email = "Enter a valid email address.";
  if (!password) errors.password = "Enter your password.";
  return errors;
}

function loginErrorMessage(error: unknown): string {
  if (isApiError(error, 401))
    return "That email and password don't match. Check them and try again.";
  return errorMessage(error, "Couldn't sign you in. Try again.");
}

/**
 * Email and password sign-in. Problems are explained inline and focus moves
 * to the field to fix; nothing shakes or bounces.
 */
export function LoginForm({ onSuccess }: { onSuccess: () => void | Promise<void> }) {
  const id = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const login = useLogin();

  const ids = {
    email: `${id}-email`,
    emailError: `${id}-email-error`,
    password: `${id}-password`,
    passwordError: `${id}-password-error`,
    formError: `${id}-form-error`,
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (login.isPending) return;
    const errors = validate(email, password);
    setFieldErrors(errors);
    if (errors.email) return emailRef.current?.focus();
    if (errors.password) return passwordRef.current?.focus();

    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => void onSuccess(),
        onError: (error) => {
          if (isApiError(error, 401)) {
            setPassword("");
            passwordRef.current?.focus();
          }
        },
      },
    );
  };

  const formError = login.isError ? loginErrorMessage(login.error) : null;

  return (
    <form
      noValidate
      onSubmit={submit}
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
        <Input
          ref={emailRef}
          id={ids.email}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          className="h-9"
          aria-invalid={fieldErrors.email ? true : undefined}
          aria-describedby={fieldErrors.email ? ids.emailError : undefined}
          onChange={(event) => {
            setEmail(event.target.value);
            if (fieldErrors.email) setFieldErrors((errors) => ({ ...errors, email: undefined }));
          }}
        />
        {fieldErrors.email ? (
          <p id={ids.emailError} className="text-small text-destructive">
            {fieldErrors.email}
          </p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={ids.password}>Password</Label>
        <Input
          ref={passwordRef}
          id={ids.password}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          className="h-9"
          aria-invalid={fieldErrors.password ? true : undefined}
          aria-describedby={fieldErrors.password ? ids.passwordError : undefined}
          onChange={(event) => {
            setPassword(event.target.value);
            if (fieldErrors.password) {
              setFieldErrors((errors) => ({ ...errors, password: undefined }));
            }
          }}
        />
        {fieldErrors.password ? (
          <p id={ids.passwordError} className="text-small text-destructive">
            {fieldErrors.password}
          </p>
        ) : null}
      </div>

      <Button type="submit" size="lg" className="mt-1 w-full" disabled={login.isPending}>
        {login.isPending ? (
          <>
            <LoaderCircleIcon
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
            Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </Button>
    </form>
  );
}
