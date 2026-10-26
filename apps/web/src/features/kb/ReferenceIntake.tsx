import {
  KB_AUTHOR_MAX_LENGTH,
  KB_LIKED_REASON_MAX_LENGTH,
  KB_TITLE_MAX_LENGTH,
  normalizeReferenceUrl,
  REFERENCE_URL_MAX_LENGTH,
  TranscriptSchema,
  type Workspace,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { Label } from "@loomcast/ui/components/label";
import { Textarea } from "@loomcast/ui/components/textarea";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { EntryToolbar } from "./EntryChrome";
import { SaveError, saveShortcutLabel, useCreateKbEntry } from "./editing";
import { PLATFORM_META } from "./kinds";
import { TagsInput } from "./TagsInput";
import { NoDownloadNotice, TranscriptInput } from "./TranscriptInput";
import { useSaveShortcut } from "./use-save-shortcut";

function readUrl(value: string) {
  if (!value.trim()) return null;
  try {
    return normalizeReferenceUrl(value);
  } catch {
    return null;
  }
}

/**
 * Saves a reference video: its link, why it was worth saving and, optionally, a transcript the
 * user pastes or loads. The link is only stored; Loomcast never opens or downloads it.
 */
export function ReferenceIntake({
  workspace,
  workspaceParam,
}: {
  workspace: Workspace;
  workspaceParam: string;
}) {
  const id = useId();
  const navigate = useNavigate();
  const urlRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState("");
  const [urlTouched, setUrlTouched] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [likedReason, setLikedReason] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [transcript, setTranscript] = useState("");
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const create = useCreateKbEntry(workspace.id);

  const parsed = readUrl(url);
  const urlError = urlTouched && !parsed ? "Enter an http or https link to the video." : null;
  const platform = parsed ? PLATFORM_META[parsed.platform] : null;

  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (create.isPending) return;
    setUrlTouched(true);
    if (!parsed) {
      urlRef.current?.focus();
      return;
    }
    const text = transcript.trim();
    if (text) {
      const check = TranscriptSchema.safeParse(text);
      if (!check.success) {
        setTranscriptError(check.error.issues[0]?.message ?? "Check the transcript.");
        transcriptRef.current?.querySelector("textarea")?.focus();
        return;
      }
    }
    create.mutate(
      {
        kind: "reference",
        url: url.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(author.trim() ? { author: author.trim() } : {}),
        ...(likedReason.trim() ? { likedReason: likedReason.trim() } : {}),
        ...(text ? { transcript: text } : {}),
        tags,
      },
      {
        onSuccess: (created) => {
          toast.success("Reference saved", { description: created.title });
          void navigate({
            to: "/w/$workspace/kb/$entryId",
            params: { workspace: workspaceParam, entryId: created.id },
            replace: true,
          });
        },
      },
    );
  };

  useSaveShortcut(() => save());

  return (
    <form noValidate onSubmit={save} className="flex flex-col gap-4" aria-label="Save a reference">
      <EntryToolbar workspaceParam={workspaceParam}>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Saving…" : "Save reference"}
          <kbd className="font-sans text-[11px] opacity-70 max-sm:hidden">
            {saveShortcutLabel()}
          </kbd>
        </Button>
      </EntryToolbar>

      <div className="flex flex-col gap-1">
        <h2 className="text-title">Save a reference</h2>
        <p className="text-control text-muted-foreground">
          A video worth learning from, and why. With a transcript, the studio agent can break down
          its hook, structure and pacing.
        </p>
      </div>

      <NoDownloadNotice />

      {create.isError ? (
        <SaveError
          message={errorMessage(create.error, "Couldn't save the reference. Try again.")}
        />
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-url`}>Link to the video</Label>
        <Input
          ref={urlRef}
          id={`${id}-url`}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={url}
          maxLength={REFERENCE_URL_MAX_LENGTH}
          placeholder="https://www.instagram.com/reel/…"
          aria-invalid={urlError ? true : undefined}
          aria-describedby={`${id}-url-hint`}
          onChange={(event) => setUrl(event.target.value)}
          onBlur={() => setUrlTouched(url.trim().length > 0)}
        />
        <p
          id={`${id}-url-hint`}
          className={urlError ? "text-small text-destructive" : "text-small text-muted-foreground"}
        >
          {urlError ??
            (platform && parsed ? (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                <platform.icon aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="shrink-0">{platform.label}</span>
                <span aria-hidden="true">·</span>
                <span className="truncate font-mono text-[11px]">{parsed.url}</span>
              </span>
            ) : (
              "Instagram, TikTok, YouTube, Threads, X, Facebook or any other page."
            ))}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-1.5">
          <Label htmlFor={`${id}-title`}>
            Title <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id={`${id}-title`}
            value={title}
            maxLength={KB_TITLE_MAX_LENGTH}
            autoComplete="off"
            placeholder={platform ? `${platform.label} video` : "Named after the platform"}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor={`${id}-author`}>
            Author <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id={`${id}-author`}
            value={author}
            maxLength={KB_AUTHOR_MAX_LENGTH}
            autoComplete="off"
            placeholder="@handle"
            onChange={(event) => setAuthor(event.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-liked`}>
          Why you liked it <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={`${id}-liked`}
          value={likedReason}
          rows={3}
          maxLength={KB_LIKED_REASON_MAX_LENGTH}
          placeholder="The hook, the pacing, a visual trick worth borrowing…"
          onChange={(event) => setLikedReason(event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-tags`}>Tags</Label>
        <TagsInput id={`${id}-tags`} value={tags} onChange={setTags} />
      </div>

      <div ref={transcriptRef} className="grid gap-1.5">
        <Label htmlFor={`${id}-transcript`}>
          Transcript <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <TranscriptInput
          id={`${id}-transcript`}
          value={transcript}
          describedBy={transcriptError ? `${id}-transcript-error` : undefined}
          onChange={(value) => {
            setTranscript(value);
            setTranscriptError(null);
          }}
        />
        {transcriptError ? (
          <p id={`${id}-transcript-error`} className="text-small text-destructive">
            {transcriptError}
          </p>
        ) : null}
      </div>
    </form>
  );
}
