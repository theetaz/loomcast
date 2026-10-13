import type { ContentItemDetail, ContentVersion, FormatRules, Script } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { Label } from "@loomcast/ui/components/label";
import { Textarea } from "@loomcast/ui/components/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useSaveShortcut } from "@/features/kb/use-save-shortcut";
import { EditConflictBanner, EditError, isEditConflict } from "./EditNotices";
import { LengthSummary } from "./LengthSummary";
import { contentItemQueryOptions, useEditVersion } from "./queries";
import {
  draftFromScript,
  insertSegment,
  isDraftChanged,
  moveSegment,
  removeSegment,
  type ScriptDraft,
  type SegmentDraft,
  scriptFromDraft,
  validateDraft,
} from "./script-draft";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const ALT = isMac ? "⌥" : "Alt+";

/**
 * Edits the script as segment fields. Keyboard: ⌥↑ and ⌥↓ move a segment, ⌥Enter adds one after
 * it, ⌥Backspace removes an empty one, ⌘S saves. Saving writes a new version on top of the one
 * being edited; if another version got there first, a banner offers to reload or save on top.
 */
export function ScriptEditor({
  detail,
  base,
  rules,
  onDone,
}: {
  detail: ContentItemDetail;
  base: ContentVersion & { script: Script | null };
  rules: FormatRules | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const itemId = detail.item.id;
  const [baseVersion, setBaseVersion] = useState(base);
  const baseScript = baseVersion.script as Script;
  const [draft, setDraft] = useState<ScriptDraft>(() => draftFromScript(baseScript));
  const [notes, setNotes] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const edit = useEditVersion(itemId);
  const ids = { hook: useId(), cta: useId(), caption: useId(), notes: useId() };

  const changed = isDraftChanged(draft, baseScript);
  const conflict = edit.isError && isEditConflict(edit.error);
  const stale = !conflict && detail.currentVersion.id !== baseVersion.id;
  const losesVoice = baseVersion.voiceAssetId !== null || baseVersion.renderAssetId !== null;
  const leavesReview = detail.item.state === "review" || detail.item.state === "approved";

  // Keyboard moves keep focus on the moved segment.
  useEffect(() => {
    if (!focusKey) return;
    listRef.current
      ?.querySelector<HTMLTextAreaElement>(`[data-segment="${focusKey}"] textarea`)
      ?.focus();
    setFocusKey(null);
  }, [focusKey]);

  const save = (baseVersionId = baseVersion.id) => {
    if (edit.isPending) return;
    const problem = validateDraft(draft, baseScript);
    setInvalid(problem);
    if (problem || !changed) return;
    edit.mutate(
      {
        baseVersionId,
        script: scriptFromDraft(draft, baseScript),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
      {
        onSuccess: ({ version }) => {
          toast.success(`Saved as v${version.versionNo}`, { description: detail.item.title });
          onDone();
        },
      },
    );
  };

  useSaveShortcut(() => save());

  const reload = async () => {
    const latest = await queryClient.fetchQuery({
      ...contentItemQueryOptions(itemId),
      staleTime: 0,
    });
    edit.reset();
    if (!latest.currentVersion.script) {
      onDone();
      return;
    }
    setBaseVersion(latest.currentVersion);
    setDraft(draftFromScript(latest.currentVersion.script));
  };

  const overwrite = async () => {
    const latest = await queryClient.fetchQuery({
      ...contentItemQueryOptions(itemId),
      staleTime: 0,
    });
    edit.reset();
    setBaseVersion(latest.currentVersion);
    save(latest.currentVersion.id);
  };

  const setSegments = (segments: SegmentDraft[]) =>
    setDraft((current) => ({ ...current, segments }));
  const updateSegment = (key: string, patch: Partial<SegmentDraft>) =>
    setSegments(
      draft.segments.map((segment) => (segment.key === key ? { ...segment, ...patch } : segment)),
    );

  const move = (index: number, delta: -1 | 1) => {
    const segment = draft.segments[index];
    const target = index + delta;
    if (!segment || target < 0 || target >= draft.segments.length) return;
    setSegments(moveSegment(draft.segments, index, delta));
    setFocusKey(segment.key);
    setAnnouncement(`Segment moved to position ${target + 1} of ${draft.segments.length}.`);
  };

  const add = (index: number) => {
    const { segments, segment } = insertSegment(draft.segments, index);
    setSegments(segments);
    setFocusKey(segment.key);
    setAnnouncement(`Segment added at position ${index + 2}.`);
  };

  const remove = (index: number) => {
    if (draft.segments.length <= 1) return;
    const previous = draft.segments[index - 1] ?? draft.segments[index + 1];
    setSegments(removeSegment(draft.segments, index));
    if (previous) setFocusKey(previous.key);
    setAnnouncement(`Segment ${index + 1} removed.`);
  };

  const onSegmentKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, index: number) => {
    if (!event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      move(index, event.key === "ArrowUp" ? -1 : 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      add(index);
    } else if (event.key === "Backspace" && event.currentTarget.value.trim() === "") {
      event.preventDefault();
      remove(index);
    }
  };

  const preview = scriptFromDraft(draft, baseScript);

  return (
    <form
      aria-label="Edit script"
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-divider border-b px-4 py-2.5">
        <LengthSummary
          script={preview}
          speed={rules?.voiceSpeed ?? 1}
          target={rules?.lengthSec ?? null}
        />
        <p className="ml-auto text-small text-text-4 max-md:hidden">
          {ALT}↑ {ALT}↓ move · {ALT}Enter add · {isMac ? "⌘S" : "Ctrl+S"} save
        </p>
      </div>

      <div className="flex flex-col gap-4 px-4 py-4">
        {conflict || stale ? (
          <EditConflictBanner
            kind={conflict ? "conflict" : "stale"}
            busy={edit.isPending}
            onReload={() => void reload()}
            onOverwrite={() => void overwrite()}
          />
        ) : null}
        {edit.isError && !conflict ? <EditError error={edit.error} /> : null}
        {losesVoice || leavesReview ? (
          <p className="rounded-md bg-secondary px-3 py-2 text-small text-text-2">
            {losesVoice
              ? "Saving a changed script drops the voice and the video; they are made again from the new words."
              : "Saving a changed script takes the video out of review."}
          </p>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.hook}>Hook</Label>
          <Textarea
            id={ids.hook}
            value={draft.hook}
            rows={2}
            className="min-h-0 bg-ember/5"
            onChange={(event) => setDraft({ ...draft, hook: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-2">
          <p id="segments-label" className="font-medium text-control">
            Segments
          </p>
          <ol ref={listRef} aria-labelledby="segments-label" className="flex flex-col gap-2">
            {draft.segments.map((segment, index) => (
              <li
                key={segment.key}
                data-segment={segment.key}
                className="flex flex-col gap-1.5 rounded-md bg-secondary/60 p-2.5"
              >
                <div className="flex items-center gap-1">
                  <span className="font-medium text-small text-muted-foreground">
                    Segment {index + 1}
                  </span>
                  <span className="font-mono text-mono text-text-4">{segment.id}</span>
                  <div className="ml-auto flex items-center gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Move segment ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUpIcon aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Move segment ${index + 1} down`}
                      disabled={index === draft.segments.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDownIcon aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove segment ${index + 1}`}
                      disabled={draft.segments.length <= 1}
                      onClick={() => remove(index)}
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <Textarea
                  aria-label={`Segment ${index + 1} text`}
                  value={segment.text}
                  rows={2}
                  className="min-h-0"
                  onChange={(event) => updateSegment(segment.key, { text: event.target.value })}
                  onKeyDown={(event) => onSegmentKeyDown(event, index)}
                />
                <Input
                  aria-label={`Segment ${index + 1} on-screen text`}
                  placeholder="On-screen text (optional)"
                  value={segment.onScreenText}
                  className="h-7 font-mono text-mono"
                  onChange={(event) =>
                    updateSegment(segment.key, { onScreenText: event.target.value })
                  }
                />
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => add(draft.segments.length - 1)}
          >
            <PlusIcon aria-hidden="true" />
            Add segment
          </Button>
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.cta}>Call to action</Label>
            <Input
              id={ids.cta}
              value={draft.cta}
              onChange={(event) => setDraft({ ...draft, cta: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.notes}>What changed (optional)</Label>
            <Input
              id={ids.notes}
              value={notes}
              placeholder="Shown in the version history"
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.caption}>Caption</Label>
          <Textarea
            id={ids.caption}
            value={draft.caption}
            rows={2}
            className="min-h-0"
            onChange={(event) => setDraft({ ...draft, caption: event.target.value })}
          />
        </div>

        {invalid ? (
          <p role="alert" className="text-small text-destructive">
            {invalid}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-1.5">
          <Button type="button" variant="ghost" disabled={edit.isPending} onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={!changed || edit.isPending}>
            {edit.isPending ? "Saving…" : "Save as new version"}
          </Button>
        </div>
      </div>
    </form>
  );
}
