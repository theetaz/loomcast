import {
  KB_TITLE_MAX_LENGTH,
  type KbEntryDetail,
  type UpdateKbEntry,
  type Workspace,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { Label } from "@loomcast/ui/components/label";
import { useNavigate } from "@tanstack/react-router";
import { HistoryIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/RelativeTime";
import { errorMessage, isApiError } from "@/lib/api";
import { clearDraft, type Draft, draftKey, readDraft, writeDraft } from "./draft";
import { DeleteEntryButton, EntryMeta, EntryToolbar } from "./EntryChrome";
import {
  ConflictBanner,
  SaveError,
  saveShortcutLabel,
  useCreateKbEntry,
  useFetchLatestEntry,
  useUpdateKbEntry,
} from "./editing";
import { KIND_META } from "./kinds";
import { MarkdownField } from "./MarkdownField";
import { TagsInput } from "./TagsInput";
import { useSaveShortcut } from "./use-save-shortcut";

/** Drafts are written this long after the last change. */
const DRAFT_DELAY_MS = 400;

interface TextContent {
  title: string;
  tags: string[];
  bodyMd: string;
}

interface Base extends TextContent {
  /** The `updatedAt` a save expects; null before the entry exists. */
  updatedAt: string | null;
}

const EMPTY: TextContent = { title: "", tags: [], bodyMd: "" };

function contentOf(source: TextContent): TextContent {
  return { title: source.title, tags: [...source.tags], bodyMd: source.bodyMd };
}

export function sameContent(a: TextContent, b: TextContent): boolean {
  return (
    a.title === b.title &&
    a.bodyMd === b.bodyMd &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index])
  );
}

/** The fields of `form` that differ from `base`, as an update body. */
export function changedFields(
  form: TextContent,
  base: Base,
): Omit<UpdateKbEntry, "expectedUpdatedAt"> {
  return {
    ...(form.title.trim() !== base.title ? { title: form.title.trim() } : {}),
    ...(form.bodyMd !== base.bodyMd ? { bodyMd: form.bodyMd } : {}),
    ...(sameContent({ ...EMPTY, tags: form.tags }, { ...EMPTY, tags: base.tags })
      ? {}
      : { tags: form.tags }),
  };
}

export interface TextEntryEditorProps {
  workspace: Workspace;
  workspaceParam: string;
  kind: "brainstorm" | "note";
  /** The stored entry; omitted when creating one. */
  entry?: KbEntryDetail;
}

/**
 * The brainstorm and note editor: title, tags and markdown with a preview. Unsaved changes are
 * kept as a draft in localStorage and restored on return; ⌘S or Ctrl+S saves. A save that finds
 * the entry changed elsewhere (409) offers to reload or overwrite.
 */
export function TextEntryEditor({ workspace, workspaceParam, kind, entry }: TextEntryEditorProps) {
  const id = useId();
  const navigate = useNavigate();
  const key = entry
    ? draftKey({ entryId: entry.id })
    : draftKey({ workspaceId: workspace.id, kind });
  const titleRef = useRef<HTMLInputElement>(null);

  const [initial] = useState(() => {
    const server = entry ? contentOf(entry) : EMPTY;
    const draft = readDraft(key);
    const restored = draft && !sameContent(draft, server) ? draft : null;
    return {
      form: restored ? contentOf(restored) : server,
      base: {
        ...server,
        updatedAt: restored?.baseUpdatedAt ?? entry?.updatedAt ?? null,
      } satisfies Base,
      restored,
    };
  });
  const [form, setForm] = useState<TextContent>(initial.form);
  const [base, setBase] = useState<Base>(initial.base);
  const [restored, setRestored] = useState<Draft | null>(initial.restored);
  const [conflict, setConflict] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const create = useCreateKbEntry(workspace.id);
  const update = useUpdateKbEntry(entry?.id ?? "");
  const fetchLatest = useFetchLatestEntry();
  const pending = create.isPending || update.isPending || resolving;
  const dirty = !sameContent(form, base);
  const label = KIND_META[kind].label;

  // Keep unsaved changes on this device until they are saved or discarded.
  useEffect(() => {
    if (!dirty) {
      clearDraft(key);
      return;
    }
    const timer = setTimeout(
      () =>
        writeDraft(key, {
          ...form,
          baseUpdatedAt: base.updatedAt,
          savedAt: new Date().toISOString(),
        }),
      DRAFT_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [dirty, form, base.updatedAt, key]);

  const applySaved = (saved: KbEntryDetail) => {
    clearDraft(key);
    setBase({ ...contentOf(saved), updatedAt: saved.updatedAt });
    setRestored(null);
    setConflict(false);
  };

  const onSaveError = (error: unknown) => {
    if (isApiError(error, 409)) setConflict(true);
  };

  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (pending) return;
    const title = form.title.trim();
    if (!title) {
      setTitleError("Give the entry a title.");
      titleRef.current?.focus();
      return;
    }
    if (!entry) {
      create.mutate(
        { kind, title, bodyMd: form.bodyMd, tags: form.tags },
        {
          onSuccess: (created) => {
            clearDraft(key);
            toast.success(`${label} saved`, { description: created.title });
            void navigate({
              to: "/w/$workspace/kb/$entryId",
              params: { workspace: workspaceParam, entryId: created.id },
              replace: true,
            });
          },
        },
      );
      return;
    }
    if (!dirty || base.updatedAt === null) return;
    update.mutate(
      { expectedUpdatedAt: base.updatedAt, ...changedFields(form, base) },
      {
        onSuccess: (saved) => {
          applySaved(saved);
          toast.success("Saved");
        },
        onError: onSaveError,
      },
    );
  };

  useSaveShortcut(() => save());

  const reload = async () => {
    if (!entry) return;
    setResolving(true);
    try {
      const latest = await fetchLatest(entry.id);
      setForm(contentOf(latest));
      applySaved(latest);
      update.reset();
    } catch (error) {
      toast.error("Couldn't reload the entry", { description: errorMessage(error) });
    } finally {
      setResolving(false);
    }
  };

  const overwrite = async () => {
    if (!entry) return;
    setResolving(true);
    try {
      const latest = await fetchLatest(entry.id);
      const saved = await update.mutateAsync({
        expectedUpdatedAt: latest.updatedAt,
        title: form.title.trim() || latest.title,
        bodyMd: form.bodyMd,
        tags: form.tags,
      });
      applySaved(saved);
      toast.success("Saved over the other changes");
    } catch (error) {
      onSaveError(error);
      if (!isApiError(error, 409)) {
        toast.error("Couldn't save the entry", { description: errorMessage(error) });
      }
    } finally {
      setResolving(false);
    }
  };

  const discardDraft = () => {
    const server = entry ? contentOf(entry) : EMPTY;
    setForm(server);
    setBase({ ...server, updatedAt: entry?.updatedAt ?? null });
    clearDraft(key);
    setRestored(null);
  };

  // A live event moved the stored entry past the version this editor started from.
  const stale =
    !conflict && entry !== undefined && base.updatedAt !== null && entry.updatedAt > base.updatedAt;

  const saveError = create.error ?? update.error;
  const status = pending
    ? "Saving…"
    : dirty
      ? "Unsaved changes, kept on this device"
      : entry
        ? "All changes saved"
        : "";

  return (
    <form noValidate onSubmit={save} className="flex flex-col gap-4" aria-label={`${label} editor`}>
      <EntryToolbar workspaceParam={workspaceParam}>
        <span aria-live="polite" className="text-small text-muted-foreground max-sm:hidden">
          {status}
        </span>
        {entry ? <DeleteEntryButton entry={entry} workspaceParam={workspaceParam} /> : null}
        <Button type="submit" disabled={pending || (entry !== undefined && !dirty)}>
          {pending ? "Saving…" : entry ? "Save" : `Save ${label.toLowerCase()}`}
          <kbd className="font-sans text-[11px] opacity-70 max-sm:hidden">
            {saveShortcutLabel()}
          </kbd>
        </Button>
      </EntryToolbar>

      {entry ? null : <h1 className="text-title">New {label.toLowerCase()}</h1>}

      {conflict || stale ? (
        <ConflictBanner
          kind={conflict ? "conflict" : "stale"}
          busy={pending}
          onReload={() => void reload()}
          onOverwrite={() => void overwrite()}
        />
      ) : null}

      {restored ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-accent-soft px-3.5 py-2.5 text-body"
        >
          <HistoryIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <p className="min-w-0 flex-1">
            Restored your unsaved changes from{" "}
            <RelativeTime value={restored.savedAt} format="relative" />.
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={discardDraft}>
            Discard them
          </Button>
        </div>
      ) : null}

      {saveError && !isApiError(saveError, 409) ? (
        <SaveError message={errorMessage(saveError, "Couldn't save the entry. Try again.")} />
      ) : null}

      {entry ? <EntryMeta entry={entry} /> : null}

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          ref={titleRef}
          id={`${id}-title`}
          value={form.title}
          maxLength={KB_TITLE_MAX_LENGTH}
          autoComplete="off"
          // A new entry starts at its title.
          autoFocus={!entry}
          placeholder={
            kind === "brainstorm" ? "Hooks that open on the error" : "Recording checklist"
          }
          aria-invalid={titleError ? true : undefined}
          aria-describedby={titleError ? `${id}-title-error` : undefined}
          className="h-9 font-semibold text-[15px]"
          onChange={(event) => {
            setForm((current) => ({ ...current, title: event.target.value }));
            if (titleError) setTitleError(null);
          }}
        />
        {titleError ? (
          <p id={`${id}-title-error`} className="text-small text-destructive">
            {titleError}
          </p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-tags`}>Tags</Label>
        <TagsInput
          id={`${id}-tags`}
          value={form.tags}
          onChange={(tags) => setForm((current) => ({ ...current, tags }))}
        />
      </div>

      <MarkdownField
        id={`${id}-body`}
        label="Text"
        value={form.bodyMd}
        placeholder={
          kind === "brainstorm"
            ? "Rough ideas, angles and hooks. Markdown works."
            : "Anything worth keeping. Markdown works."
        }
        onChange={(bodyMd) => setForm((current) => ({ ...current, bodyMd }))}
      />
    </form>
  );
}
