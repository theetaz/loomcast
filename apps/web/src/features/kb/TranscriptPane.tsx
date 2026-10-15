import { type KbEntryDetail, TranscriptSchema } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { cn } from "@loomcast/ui/lib/cn";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronUpIcon, FileTextIcon, PencilIcon, SearchIcon } from "lucide-react";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage, isApiError } from "@/lib/api";
import { MATCH_CLASS_NAME } from "@/lib/snippet";
import { useUpdateKbEntry } from "./editing";
import { findParts, matchCount } from "./find";
import { kbKeys } from "./queries";
import { NoDownloadNotice, TranscriptInput } from "./TranscriptInput";

/**
 * The reference's transcript in mono with find-in-transcript: Enter and Shift+Enter step through
 * matches, Escape clears. The transcript can be added or replaced here.
 */
export function TranscriptPane({ entry }: { entry: KbEntryDetail }) {
  const transcript = entry.reference?.transcript ?? "";
  const [editing, setEditing] = useState(false);

  return (
    <section
      aria-label="Transcript"
      className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-card shadow-card"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-divider border-b pr-2 pl-3.5">
        <h3 className="font-semibold text-[13px]">Transcript</h3>
        {transcript && !editing ? (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setEditing(true)}>
            <PencilIcon aria-hidden="true" />
            Replace
          </Button>
        ) : null}
      </div>
      {editing ? (
        <TranscriptEditor entry={entry} onDone={() => setEditing(false)} />
      ) : transcript ? (
        <TranscriptFind transcript={transcript} />
      ) : (
        <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
          <FileTextIcon aria-hidden="true" className="size-5 text-muted-foreground" />
          <p className="max-w-sm text-control text-muted-foreground">
            No transcript yet. Add one to search it here and to let the studio agent analyze the
            video.
          </p>
          <Button variant="outline" onClick={() => setEditing(true)}>
            Add transcript
          </Button>
        </div>
      )}
    </section>
  );
}

function TranscriptFind({ transcript }: { transcript: string }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const deferredQuery = useDeferredValue(query.trim());
  const parts = useMemo(() => findParts(transcript, deferredQuery), [transcript, deferredQuery]);
  const total = matchCount(parts);
  const active = total === 0 ? -1 : Math.min(current, total - 1);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Keep the current match in view; jumps, not scrolls, since stepping is a keyboard action.
  useEffect(() => {
    if (active < 0) return;
    bodyRef.current
      ?.querySelector(`[data-match="${active}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const step = (delta: number) => {
    if (total === 0) return;
    setCurrent((value) => (Math.min(value, total - 1) + delta + total) % total);
  };

  return (
    <>
      <div className="flex items-center gap-1.5 border-divider border-b px-3.5 py-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Find in transcript"
            aria-describedby={`${id}-count`}
            placeholder="Find in transcript"
            value={query}
            className="h-7.5 pl-8"
            onChange={(event) => {
              setQuery(event.target.value);
              setCurrent(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
          />
        </div>
        <span
          id={`${id}-count`}
          aria-live="polite"
          className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums"
        >
          {deferredQuery ? (total === 0 ? "No matches" : `${active + 1} of ${total}`) : ""}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous match"
          disabled={total === 0}
          onClick={() => step(-1)}
        >
          <ChevronUpIcon aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next match"
          disabled={total === 0}
          onClick={() => step(1)}
        >
          <ChevronDownIcon aria-hidden="true" />
        </Button>
      </div>
      <ScrollArea
        role="region"
        aria-label="Transcript text"
        viewportRef={bodyRef}
        // A scrollable region must be reachable from the keyboard.
        viewportProps={{ tabIndex: 0 }}
        viewportClassName="max-h-[560px] min-h-40"
      >
        <div className="whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-[12px] text-text-2 leading-relaxed">
          {parts.map((part, index) =>
            part.match === null ? (
              <span key={index}>{part.text}</span>
            ) : (
              <mark
                key={index}
                data-match={part.match}
                aria-current={part.match === active ? "true" : undefined}
                className={cn(
                  MATCH_CLASS_NAME,
                  part.match === active && "bg-primary text-primary-foreground",
                )}
              >
                {part.text}
              </mark>
            ),
          )}
        </div>
      </ScrollArea>
    </>
  );
}

function TranscriptEditor({ entry, onDone }: { entry: KbEntryDetail; onDone: () => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(entry.reference?.transcript ?? "");
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateKbEntry(entry.id);

  const save = () => {
    const text = value.trim();
    let transcript: string | null = null;
    if (text) {
      const check = TranscriptSchema.safeParse(text);
      if (!check.success) {
        setError(check.error.issues[0]?.message ?? "Check the transcript.");
        return;
      }
      transcript = check.data;
    }
    update.mutate(
      { expectedUpdatedAt: entry.updatedAt, transcript },
      {
        onSuccess: () => {
          toast.success(transcript ? "Transcript saved" : "Transcript removed");
          onDone();
        },
        onError: (failure) => {
          if (isApiError(failure, 409)) {
            void queryClient.invalidateQueries({ queryKey: kbKeys.detail(entry.id) });
            setError(
              "This reference changed elsewhere and has been reloaded. Check it, then save again.",
            );
          } else {
            setError(errorMessage(failure, "Couldn't save the transcript. Try again."));
          }
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-3 p-3.5">
      <NoDownloadNotice />
      <label htmlFor={`${id}-input`} className="sr-only">
        Transcript
      </label>
      <TranscriptInput
        id={`${id}-input`}
        value={value}
        disabled={update.isPending}
        describedBy={error ? `${id}-error` : undefined}
        onChange={(next) => {
          setValue(next);
          setError(null);
        }}
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-small text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={update.isPending}>
          Cancel
        </Button>
        <Button type="button" onClick={save} disabled={update.isPending}>
          {update.isPending ? "Saving…" : "Save transcript"}
        </Button>
      </div>
    </div>
  );
}
