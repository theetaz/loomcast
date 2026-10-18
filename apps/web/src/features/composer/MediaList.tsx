import { ALT_TEXT_MAX_LENGTH } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { cn } from "@loomcast/ui/lib/cn";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  ImageIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import { type DragEvent, useState } from "react";
import { formatBytes } from "@/features/content-item/media-format";
import type { PostMediaProgress } from "@/features/post-formats/media-upload";
import type { MediaDraft } from "./draft";

const STAGE_LABELS: Record<PostMediaProgress["stage"], string> = {
  checksum: "Checking",
  upload: "Uploading",
  verify: "Verifying",
  done: "Uploaded",
};

export interface MediaListProps {
  media: readonly MediaDraft[];
  /** Upload progress by draft key, while saving. */
  progress: Record<string, PostMediaProgress>;
  /** Whether more than one entry is allowed, so the order matters. */
  ordered: boolean;
  disabled?: boolean;
  onMove: (from: number, to: number) => void;
  onRemove: (key: string) => void;
  onAltText: (key: string, altText: string) => void;
}

/**
 * The photos and videos of the post, in order. Rows can be dragged into a new order, or moved
 * with their Up and Down buttons from the keyboard; each photo takes its alt text. Focus stays
 * on the moved row's button, so a run of moves needs no hunting.
 */
export function MediaList({
  media,
  progress,
  ordered,
  disabled = false,
  onMove,
  onRemove,
  onAltText,
}: MediaListProps) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const count = media.length;

  const move = (from: number, to: number, focus?: "up" | "down") => {
    if (to < 0 || to >= count) return;
    onMove(from, to);
    setAnnouncement(`Moved to position ${to + 1} of ${count}.`);
    if (focus) {
      // After React puts the row in its new place, keep focus on the same button of that row.
      requestAnimationFrame(() => {
        const target =
          document.querySelector<HTMLButtonElement>(`[data-move="${focus}"][data-index="${to}"]`) ??
          document.querySelector<HTMLButtonElement>(
            `[data-move="${focus === "up" ? "down" : "up"}"][data-index="${to}"]`,
          );
        target?.focus();
      });
    }
  };

  const onDrop = (event: DragEvent<HTMLLIElement>, index: number) => {
    event.preventDefault();
    if (dragging !== null) move(dragging, index);
    setDragging(null);
    setOver(null);
  };

  return (
    <>
      <ol aria-label="Photos and videos" className="grid gap-1.5">
        {media.map((entry, index) => {
          const state = progress[entry.key];
          const label = `${entry.type === "image" ? "Photo" : "Video"} ${index + 1}`;
          return (
            <li
              key={entry.key}
              data-media-key={entry.key}
              draggable={ordered && !disabled}
              onDragStart={(event) => {
                setDragging(index);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", entry.key);
              }}
              onDragOver={(event) => {
                if (dragging === null) return;
                event.preventDefault();
                setOver(index);
              }}
              onDragLeave={() => setOver((current) => (current === index ? null : current))}
              onDrop={(event) => onDrop(event, index)}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              className={cn(
                "flex items-start gap-2.5 rounded-md bg-card p-2 shadow-card transition-[opacity,box-shadow] motion-reduce:transition-none",
                dragging === index && "opacity-50",
                over === index && dragging !== index && "shadow-[0_0_0_2px_var(--ring)]",
              )}
            >
              {ordered ? (
                <GripVerticalIcon
                  aria-hidden="true"
                  className="mt-3.5 size-4 shrink-0 cursor-grab text-text-4"
                />
              ) : null}
              <Thumb entry={entry} />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-1.5 text-small">
                  <span className="font-medium text-foreground">{label}</span>
                  <span className="min-w-0 truncate text-muted-foreground" title={entry.file.name}>
                    {entry.file.name}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                    {formatBytes(entry.file.size)}
                  </span>
                </div>
                {entry.type === "image" ? (
                  <Input
                    aria-label={`Alt text for ${label.toLowerCase()}`}
                    placeholder="Alt text: what the photo shows"
                    value={entry.altText}
                    maxLength={ALT_TEXT_MAX_LENGTH}
                    disabled={disabled}
                    onChange={(event) => onAltText(entry.key, event.target.value)}
                    className="h-8"
                  />
                ) : null}
                {state ? (
                  <UploadBar label={label} progress={state} uploaded={Boolean(entry.assetId)} />
                ) : entry.assetId ? (
                  <span className="text-small text-muted-foreground">Uploaded</span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center">
                {ordered ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      data-move="up"
                      data-index={index}
                      aria-label={`Move ${label.toLowerCase()} up`}
                      disabled={disabled || index === 0}
                      onClick={() => move(index, index - 1, "up")}
                    >
                      <ArrowUpIcon aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      data-move="down"
                      data-index={index}
                      aria-label={`Move ${label.toLowerCase()} down`}
                      disabled={disabled || index === count - 1}
                      onClick={() => move(index, index + 1, "down")}
                    >
                      <ArrowDownIcon aria-hidden="true" />
                    </Button>
                  </>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${label.toLowerCase()}`}
                  disabled={disabled}
                  onClick={() => onRemove(entry.key)}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  );
}

function Thumb({ entry }: { entry: MediaDraft }) {
  const Icon = entry.type === "image" ? ImageIcon : VideoIcon;
  return (
    <span className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-[5px] bg-secondary shadow-[0_0_0_1px_var(--border)]">
      {entry.type === "image" ? (
        <img src={entry.url} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <Icon aria-hidden="true" className="size-4 text-text-4" />
      )}
    </span>
  );
}

function UploadBar({
  label,
  progress,
  uploaded,
}: {
  label: string;
  progress: PostMediaProgress;
  uploaded: boolean;
}) {
  const done = uploaded || progress.stage === "done";
  const share = done ? 1 : progress.stage === "upload" ? progress.share : 0;
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={`${label} upload`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
        className="h-1 flex-1 overflow-hidden rounded-full bg-secondary"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out motion-reduce:transition-none"
          style={{ width: `${share * 100}%` }}
        />
      </div>
      <span className="shrink-0 text-small text-muted-foreground">
        {done ? STAGE_LABELS.done : STAGE_LABELS[progress.stage]}
      </span>
    </div>
  );
}
