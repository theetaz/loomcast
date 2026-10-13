import {
  KB_DECISION_MAX_LENGTH,
  KB_RATIONALE_MAX_LENGTH,
  KB_TITLE_MAX_LENGTH,
  type KbEntry,
  type KbEntryDetail,
  type Project,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { Label } from "@loomcast/ui/components/label";
import { Textarea } from "@loomcast/ui/components/textarea";
import { useNavigate } from "@tanstack/react-router";
import { ReplaceIcon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage, isApiError } from "@/lib/api";
import { decisionOf } from "./decisions";
import { EntryToolbar } from "./EntryChrome";
import {
  ConflictBanner,
  SaveError,
  saveShortcutLabel,
  useCreateKbEntry,
  useFetchLatestEntry,
  useUpdateKbEntry,
} from "./editing";
import { TagsInput } from "./TagsInput";
import { useSaveShortcut } from "./use-save-shortcut";

interface DecisionFields {
  title: string;
  decision: string;
  rationale: string;
  tags: string[];
}

function fieldsOf(entry: KbEntry): DecisionFields {
  const data = decisionOf(entry);
  return {
    title: entry.title,
    decision: data.decision,
    rationale: data.rationale ?? "",
    tags: [...entry.tags],
  };
}

export interface DecisionFormProps {
  project: Project;
  projectParam: string;
  /** The decision being edited; omitted when recording a new one. */
  entry?: KbEntryDetail;
  /** The decision a new one replaces. */
  supersedes?: KbEntry;
  /** Called after an edit is saved or cancelled. */
  onDone?: () => void;
}

/**
 * Records a decision (optionally replacing an earlier one) or edits one. ⌘S or Ctrl+S saves; an
 * edit that finds the decision changed elsewhere (409) offers to reload or overwrite.
 */
export function DecisionForm({
  project,
  projectParam,
  entry,
  supersedes,
  onDone,
}: DecisionFormProps) {
  const id = useId();
  const navigate = useNavigate();
  const titleRef = useRef<HTMLInputElement>(null);
  const decisionRef = useRef<HTMLTextAreaElement>(null);
  const [form, setForm] = useState<DecisionFields>(() =>
    entry
      ? fieldsOf(entry)
      : { title: "", decision: "", rationale: "", tags: supersedes ? [...supersedes.tags] : [] },
  );
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(entry?.updatedAt ?? null);
  const [errors, setErrors] = useState<{ title?: string; decision?: string }>({});
  const [conflict, setConflict] = useState(false);
  const [resolving, setResolving] = useState(false);

  const create = useCreateKbEntry(project.id);
  const update = useUpdateKbEntry(entry?.id ?? "");
  const fetchLatest = useFetchLatestEntry();
  const pending = create.isPending || update.isPending || resolving;

  const set = <K extends keyof DecisionFields>(key: K, value: DecisionFields[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (key === "title" || key === "decision")
      setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const validate = (): boolean => {
    const next = {
      ...(form.title.trim() ? {} : { title: "Give the decision a short title." }),
      ...(form.decision.trim() ? {} : { decision: "Say what was decided." }),
    };
    setErrors(next);
    if (next.title) titleRef.current?.focus();
    else if (next.decision) decisionRef.current?.focus();
    return !next.title && !next.decision;
  };

  const updateBody = (base: string) => ({
    expectedUpdatedAt: base,
    title: form.title.trim(),
    decision: form.decision.trim(),
    rationale: form.rationale.trim() || null,
    tags: form.tags,
  });

  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (pending || !validate()) return;
    if (!entry) {
      create.mutate(
        {
          kind: "decision",
          title: form.title.trim(),
          decision: form.decision.trim(),
          ...(form.rationale.trim() ? { rationale: form.rationale.trim() } : {}),
          tags: form.tags,
          ...(supersedes ? { supersedes: supersedes.id } : {}),
        },
        {
          onSuccess: (created) => {
            toast.success(supersedes ? "Decision replaced" : "Decision recorded", {
              description: created.title,
            });
            void navigate({
              to: "/projects/$projectId/kb/$entryId",
              params: { projectId: projectParam, entryId: created.id },
              replace: true,
            });
          },
        },
      );
      return;
    }
    if (expectedUpdatedAt === null) return;
    update.mutate(updateBody(expectedUpdatedAt), {
      onSuccess: () => {
        toast.success("Decision saved");
        onDone?.();
      },
      onError: (error) => {
        if (isApiError(error, 409)) setConflict(true);
      },
    });
  };

  useSaveShortcut(() => save());

  const reload = async () => {
    if (!entry) return;
    setResolving(true);
    try {
      const latest = await fetchLatest(entry.id);
      setForm(fieldsOf(latest));
      setExpectedUpdatedAt(latest.updatedAt);
      setConflict(false);
      update.reset();
    } catch (error) {
      toast.error("Couldn't reload the decision", { description: errorMessage(error) });
    } finally {
      setResolving(false);
    }
  };

  const overwrite = async () => {
    if (!entry || !validate()) return;
    setResolving(true);
    try {
      const latest = await fetchLatest(entry.id);
      await update.mutateAsync(updateBody(latest.updatedAt));
      toast.success("Saved over the other changes");
      onDone?.();
    } catch (error) {
      if (!isApiError(error, 409)) {
        toast.error("Couldn't save the decision", { description: errorMessage(error) });
      }
    } finally {
      setResolving(false);
    }
  };

  const saveError = create.error ?? update.error;

  return (
    <form
      noValidate
      onSubmit={save}
      className="flex flex-col gap-4"
      aria-label={entry ? "Edit decision" : "Record a decision"}
    >
      <EntryToolbar projectParam={projectParam}>
        {onDone ? (
          <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : entry ? "Save decision" : "Record decision"}
          <kbd className="font-sans text-[11px] opacity-70 max-sm:hidden">
            {saveShortcutLabel()}
          </kbd>
        </Button>
      </EntryToolbar>

      {!entry ? (
        <h2 className="text-title">{supersedes ? "Replace a decision" : "Record a decision"}</h2>
      ) : null}

      {supersedes ? (
        <div className="flex gap-3 rounded-lg bg-secondary px-3.5 py-3 shadow-[0_0_0_1px_var(--border)]">
          <ReplaceIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-small text-muted-foreground">
              Replaces this decision, which will be marked superseded:
            </p>
            <p className="break-words font-medium text-body">{supersedes.title}</p>
            <p className="line-clamp-3 whitespace-pre-line break-words text-body text-text-2">
              {decisionOf(supersedes).decision}
            </p>
          </div>
        </div>
      ) : null}

      {conflict ? (
        <ConflictBanner
          kind="conflict"
          busy={pending}
          onReload={() => void reload()}
          onOverwrite={() => void overwrite()}
        />
      ) : null}
      {saveError && !isApiError(saveError, 409) ? (
        <SaveError message={errorMessage(saveError, "Couldn't save the decision. Try again.")} />
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          ref={titleRef}
          id={`${id}-title`}
          value={form.title}
          maxLength={KB_TITLE_MAX_LENGTH}
          autoComplete="off"
          autoFocus={!entry}
          placeholder="Captions sit in the lower third"
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? `${id}-title-error` : undefined}
          onChange={(event) => set("title", event.target.value)}
        />
        {errors.title ? (
          <p id={`${id}-title-error`} className="text-small text-destructive">
            {errors.title}
          </p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-decision`}>Decision</Label>
        <Textarea
          ref={decisionRef}
          id={`${id}-decision`}
          value={form.decision}
          rows={3}
          maxLength={KB_DECISION_MAX_LENGTH}
          placeholder="What was decided, in a sentence or two."
          aria-invalid={errors.decision ? true : undefined}
          aria-describedby={errors.decision ? `${id}-decision-error` : undefined}
          onChange={(event) => set("decision", event.target.value)}
        />
        {errors.decision ? (
          <p id={`${id}-decision-error`} className="text-small text-destructive">
            {errors.decision}
          </p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-rationale`}>
          Why <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={`${id}-rationale`}
          value={form.rationale}
          rows={4}
          maxLength={KB_RATIONALE_MAX_LENGTH}
          placeholder="The reasons, and what was tried before."
          onChange={(event) => set("rationale", event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-tags`}>Tags</Label>
        <TagsInput id={`${id}-tags`} value={form.tags} onChange={(tags) => set("tags", tags)} />
      </div>
    </form>
  );
}
