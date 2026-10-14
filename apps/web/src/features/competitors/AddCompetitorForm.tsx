import {
  type CompetitorProfile,
  CompetitorUrlError,
  parseCompetitorUrl,
  REFERENCE_URL_MAX_LENGTH,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { Label } from "@loomcast/ui/components/label";
import { PlusIcon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { PlatformDot, platformLabel } from "@/features/channels/platforms";
import { errorMessage, isApiError } from "@/lib/api";
import { useCreateCompetitor } from "./queries";
import { competitorName } from "./status";

/** The profile in `value`, or why it is not one, as a sentence. */
function readProfile(value: string): CompetitorProfile | string {
  try {
    return parseCompetitorUrl(value);
  } catch (error) {
    const message =
      error instanceof CompetitorUrlError
        ? error.message
        : "Paste an Instagram, Facebook or Threads profile link";
    return /[.!?]$/.test(message) ? message : `${message}.`;
  }
}

/** Why the server refused: a duplicate gets its own sentence, anything else the server's words. */
function createError(error: unknown, profile: CompetitorProfile | null): string {
  if (isApiError(error, 409)) {
    return profile
      ? `This project already follows ${competitorName(profile)} on ${platformLabel(profile.platform)}.`
      : "This project already follows that profile.";
  }
  return errorMessage(error, "Couldn't add the competitor. Try again.");
}

/**
 * Follows a competitor from a profile link or an Instagram `@handle`. The link is only read for
 * its platform and handle; nothing is fetched until a scan starts.
 */
export function AddCompetitorForm({ projectId }: { projectId: string }) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const create = useCreateCompetitor(projectId);
  const [value, setValue] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<CompetitorProfile | null>(null);

  const preview = value.trim() ? readProfile(value) : null;
  const previewProfile = preview && typeof preview !== "string" ? preview : null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) return;
    const profile = readProfile(value);
    if (!value.trim() || typeof profile === "string") {
      setInputError(
        value.trim() ? String(profile) : "Paste a profile link or an Instagram @handle.",
      );
      inputRef.current?.focus();
      return;
    }
    setSubmitted(profile);
    create.mutate(
      { url: value.trim() },
      {
        onSuccess: (competitor) => {
          setValue("");
          toast.success("Competitor added", {
            description: `${competitorName(competitor)} on ${platformLabel(competitor.platform)}`,
          });
        },
      },
    );
  };

  const describedBy = inputError || create.error ? `${id}-error` : `${id}-hint`;

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-label="Add competitor"
      className="flex flex-col gap-2 rounded-lg bg-card px-3.5 py-3 shadow-card"
    >
      <Label htmlFor={`${id}-url`}>Profile link or @handle</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          ref={inputRef}
          id={`${id}-url`}
          value={value}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          maxLength={REFERENCE_URL_MAX_LENGTH}
          placeholder="instagram.com/fastrust or @fastrust"
          aria-invalid={inputError ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            setValue(event.target.value);
            if (inputError) setInputError(null);
            if (create.error) create.reset();
          }}
          className="sm:flex-1"
        />
        <Button type="submit" disabled={create.isPending} className="self-start">
          <PlusIcon aria-hidden="true" />
          {create.isPending ? "Adding…" : "Add competitor"}
        </Button>
      </div>
      {inputError || create.error ? (
        <p id={`${id}-error`} role="alert" className="text-small text-destructive">
          {inputError ?? createError(create.error, submitted)}
        </p>
      ) : (
        <p id={`${id}-hint`} className="text-small text-muted-foreground">
          {previewProfile ? (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
              <PlatformDot platform={previewProfile.platform} />
              <span className="shrink-0">{platformLabel(previewProfile.platform)}</span>
              <span aria-hidden="true">·</span>
              <span className="truncate font-mono text-[11px]">
                {competitorName(previewProfile)}
              </span>
            </span>
          ) : (
            "Instagram, Facebook or Threads. A handle on its own is read as Instagram."
          )}
        </p>
      )}
    </form>
  );
}
