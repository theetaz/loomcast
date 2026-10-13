import type { Storyboard, StoryboardFrame } from "@loomcast/contracts";
import { StoryboardSchema } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { useQueryClient } from "@tanstack/react-query";
import { LayoutPanelTopIcon, PencilIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { EditConflictBanner, EditError, isEditConflict } from "./EditNotices";
import { contentItemQueryOptions, useEditVersion } from "./queries";
import type { ItemTabProps } from "./tab-props";
import { formatSeconds, formatSpan, frameBar, parseCardId } from "./timing";

/**
 * The storyboard: one row per frame with its card, tier and purpose, the segment it plays over,
 * a bar placing it on the timeline, and its slot text. Editing a frame's slots saves a new
 * version.
 */
export function StoryboardTab({
  detail,
  version,
  canEdit,
  editBlocked,
  decisions,
  viewingCurrent,
}: ItemTabProps) {
  const [editingFrame, setEditingFrame] = useState<string | null>(null);
  const storyboard = version.storyboard;

  if (!storyboard) {
    return (
      <EmptyState
        size="compact"
        icon={LayoutPanelTopIcon}
        title="No storyboard yet"
        description="The studio agent sets each segment of the script to a card from the format's style."
        action={
          decisions.can("storyboard") && viewingCurrent ? (
            <Button
              type="button"
              disabled={decisions.busy || decisions.hasActiveJob}
              onClick={() => decisions.start("storyboard")}
            >
              Lay out the storyboard
            </Button>
          ) : null
        }
      />
    );
  }

  const totalMs = storyboard.frames.at(-1)?.endMs ?? 0;
  const segments = new Map(version.script?.segments.map((segment) => [segment.id, segment]) ?? []);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-divider border-b px-4 py-2.5 text-small text-muted-foreground">
        <span className="font-mono text-mono text-text-2">{storyboard.styleId}</span>
        <span aria-hidden="true">·</span>
        <span>{storyboard.frames.length} frames</span>
        <span aria-hidden="true">·</span>
        <span>{formatSeconds(totalMs)}</span>
        <span aria-hidden="true">·</span>
        <span>
          {storyboard.aspect} at {storyboard.fps} fps
        </span>
        {!canEdit && editBlocked && viewingCurrent ? (
          <span className="ml-auto text-text-4">{editBlocked}</span>
        ) : null}
      </div>
      <ol aria-label="Frames" className="flex flex-col">
        {storyboard.frames.map((frame, index) => (
          <FrameRow
            key={frame.id}
            index={index}
            frame={frame}
            totalMs={totalMs}
            segmentText={segments.get(frame.segmentId)?.text}
            canEdit={canEdit}
            editing={editingFrame === frame.id}
            onEdit={() => setEditingFrame(frame.id)}
            onDone={() => setEditingFrame(null)}
            storyboard={storyboard}
            itemId={detail.item.id}
            baseVersionId={version.id}
            currentVersionId={detail.currentVersion.id}
          />
        ))}
      </ol>
    </div>
  );
}

function FrameRow({
  index,
  frame,
  totalMs,
  segmentText,
  canEdit,
  editing,
  onEdit,
  onDone,
  storyboard,
  itemId,
  baseVersionId,
  currentVersionId,
}: {
  index: number;
  frame: StoryboardFrame;
  totalMs: number;
  segmentText: string | undefined;
  canEdit: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  storyboard: Storyboard;
  itemId: string;
  baseVersionId: string;
  currentVersionId: string;
}) {
  const card = parseCardId(frame.cardId);
  const bar = frameBar(frame, totalMs);
  const slots = Object.entries(frame.slots);

  return (
    <li className="flex flex-col gap-2 border-divider border-t px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium font-mono text-mono text-text-4 tabular-nums">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="min-w-0 truncate font-mono text-mono text-foreground" title={frame.cardId}>
          {frame.cardId}
        </span>
        {card.tier ? (
          <span className="rounded-sm bg-secondary px-1.5 py-px text-[11px] font-medium text-text-2">
            {card.tier}
          </span>
        ) : null}
        {card.purpose ? (
          <span className="text-small text-muted-foreground capitalize">{card.purpose}</span>
        ) : null}
        <span className="ml-auto font-mono text-mono text-text-4 tabular-nums">
          {formatSpan(frame.startMs, frame.endMs)}
        </span>
      </div>
      <div
        className="relative h-1.5 overflow-hidden rounded-full bg-secondary"
        role="img"
        aria-label={`Plays from ${formatSpan(frame.startMs, frame.endMs)} of ${formatSeconds(totalMs)}`}
      >
        <span
          className="absolute inset-y-0 rounded-full bg-primary/70"
          style={{ left: `${bar.left * 100}%`, width: `${Math.max(bar.width * 100, 0.8)}%` }}
        />
      </div>
      {segmentText ? (
        <p className="line-clamp-2 text-small text-muted-foreground">
          <span className="font-mono text-mono text-text-4">{frame.segmentId}</span> {segmentText}
        </p>
      ) : null}
      {editing && canEdit ? (
        <SlotEditor
          frame={frame}
          storyboard={storyboard}
          itemId={itemId}
          baseVersionId={baseVersionId}
          currentVersionId={currentVersionId}
          onDone={onDone}
        />
      ) : (
        <div className="flex items-start gap-2">
          {slots.length > 0 ? (
            <dl className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-small">
              {slots.map(([name, value]) => (
                <div key={name} className="contents">
                  <dt className="font-mono text-mono text-text-4">{name}</dt>
                  <dd className="break-words text-foreground">{value || "—"}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="flex-1 text-small text-text-4">No slots</p>
          )}
          {canEdit && slots.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Edit the slots of frame ${index + 1}`}
              onClick={onEdit}
            >
              <PencilIcon aria-hidden="true" />
              Edit
            </Button>
          ) : null}
        </div>
      )}
      {frame.notes ? <p className="text-small text-text-2">{frame.notes}</p> : null}
    </li>
  );
}

/** Inline slot fields of one frame; saving writes the storyboard as a new version. */
function SlotEditor({
  frame,
  storyboard,
  itemId,
  baseVersionId,
  currentVersionId,
  onDone,
}: {
  frame: StoryboardFrame;
  storyboard: Storyboard;
  itemId: string;
  baseVersionId: string;
  currentVersionId: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const edit = useEditVersion(itemId);
  const [slots, setSlots] = useState(frame.slots);
  const [invalid, setInvalid] = useState<string | null>(null);
  const fieldId = useId();
  const conflict = edit.isError && isEditConflict(edit.error);
  const stale = !conflict && baseVersionId !== currentVersionId;
  const changed = Object.entries(slots).some(([name, value]) => frame.slots[name] !== value);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!changed || edit.isPending) return;
    const next: Storyboard = {
      ...storyboard,
      frames: storyboard.frames.map((entry) =>
        entry.id === frame.id ? { ...entry, slots } : entry,
      ),
    };
    const parsed = StoryboardSchema.safeParse(next);
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? "Check the slot text.");
      return;
    }
    setInvalid(null);
    edit.mutate(
      { baseVersionId, storyboard: parsed.data },
      {
        onSuccess: ({ version }) => {
          toast.success(`Saved as v${version.versionNo}`);
          onDone();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} aria-label={`Slots of ${frame.id}`} className="flex flex-col gap-2">
      {conflict || stale ? (
        <EditConflictBanner
          kind={conflict ? "conflict" : "stale"}
          busy={edit.isPending}
          onReload={() => {
            void queryClient.invalidateQueries({
              queryKey: contentItemQueryOptions(itemId).queryKey,
            });
            onDone();
          }}
        />
      ) : null}
      {edit.isError && !conflict ? <EditError error={edit.error} /> : null}
      <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
        {Object.keys(frame.slots).map((name) => (
          <div key={name} className="contents">
            <label htmlFor={`${fieldId}-${name}`} className="font-mono text-mono text-text-4">
              {name}
            </label>
            <Input
              id={`${fieldId}-${name}`}
              value={slots[name] ?? ""}
              onChange={(event) => setSlots({ ...slots, [name]: event.target.value })}
              className="h-7"
            />
          </div>
        ))}
      </div>
      {invalid ? (
        <p role="alert" className="text-small text-destructive">
          {invalid}
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" disabled={edit.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!changed || edit.isPending}>
          {edit.isPending ? "Saving…" : "Save as new version"}
        </Button>
      </div>
    </form>
  );
}
