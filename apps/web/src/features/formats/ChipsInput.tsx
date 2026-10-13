import { Button } from "@loomcast/ui/components/button";
import { Textarea } from "@loomcast/ui/components/textarea";
import { cn } from "@loomcast/ui/lib/cn";
import { ListPlusIcon, XIcon } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, useId, useRef, useState } from "react";

/** Lines of pasted text as entries: trimmed, without empty lines. */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** `current` plus `added`, skipping entries already present (exactly, or ignoring case). */
export function mergeEntries(
  current: readonly string[],
  added: readonly string[],
  ignoreCase = false,
): string[] {
  const key = (value: string) => (ignoreCase ? value.toLowerCase() : value);
  const seen = new Set(current.map(key));
  const next = [...current];
  for (const entry of added) {
    if (seen.has(key(entry))) continue;
    seen.add(key(entry));
    next.push(entry);
  }
  return next;
}

export interface ChipsInputProps {
  id: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** Names one chip for screen readers, such as "topic". */
  noun: string;
  placeholder?: string;
  /** Shown before each chip, such as `#`. */
  prefix?: string;
  /** Cleans a typed entry before it is added, such as removing a leading `#`. */
  clean?: (entry: string) => string;
  /** Treat `Rust` and `rust` as the same entry. */
  ignoreCase?: boolean;
  max: number;
  maxLength?: number;
  /** Entries that failed validation, by index. */
  invalid?: ReadonlySet<number>;
  describedBy?: string;
  hasError?: boolean;
  onBlur?: () => void;
}

/**
 * A list of short entries as chips. Enter or a comma adds what was typed; pasting several lines
 * adds one entry per line, and "Paste a list" takes a longer list. Backspace in the empty field
 * removes the last chip. Chips appear and leave without animation: this is typing, done often.
 */
export function ChipsInput({
  id,
  value,
  onChange,
  noun,
  placeholder,
  prefix = "",
  clean = (entry) => entry.trim(),
  ignoreCase = false,
  max,
  maxLength,
  invalid,
  describedBy,
  hasError,
  onBlur,
}: ChipsInputProps) {
  const [draft, setDraft] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulk, setBulk] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const bulkId = useId();
  const countId = useId();

  const add = (entries: string[]) => {
    const cleaned = entries.map(clean).filter((entry) => entry.length > 0);
    if (cleaned.length === 0) return;
    onChange(mergeEntries(value, cleaned, ignoreCase));
  };

  const commitDraft = () => {
    if (!draft.trim()) return;
    add([draft]);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || (event.key === "," && draft.trim())) {
      event.preventDefault();
      commitDraft();
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!/\r?\n/.test(text)) return;
    event.preventDefault();
    add(splitLines(`${draft}${text}`));
    setDraft("");
  };

  const remove = (index: number) => {
    onChange(value.filter((_, at) => at !== index));
    inputRef.current?.focus();
  };

  const addBulk = () => {
    add(splitLines(bulk));
    setBulk("");
    setBulkOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "flex min-h-8 flex-wrap items-center gap-1 rounded-md bg-card px-1.5 py-1 shadow-card transition-shadow focus-within:shadow-focus",
          hasError && "shadow-[0_0_0_1px_var(--destructive)]",
        )}
      >
        {value.length > 0 ? (
          <ul
            aria-label={`${value.length} ${noun}${value.length === 1 ? "" : "s"}`}
            className="contents"
          >
            {value.map((entry, index) => {
              const bad = invalid?.has(index) ?? false;
              return (
                <li
                  key={`${entry}-${index}`}
                  className={cn(
                    "inline-flex h-6 max-w-full items-center gap-0.5 rounded-[6px] bg-secondary pr-0.5 pl-2 text-control shadow-[0_0_0_1px_var(--border)]",
                    bad &&
                      "bg-destructive/8 text-destructive shadow-[0_0_0_1px_var(--destructive)]",
                  )}
                >
                  <span className="truncate">
                    {prefix}
                    {entry}
                  </span>
                  {bad ? <span className="sr-only"> (not valid)</span> : null}
                  <button
                    type="button"
                    aria-label={`Remove ${noun} ${prefix}${entry}`}
                    onClick={() => remove(index)}
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground outline-none transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <XIcon aria-hidden="true" className="size-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        <input
          ref={inputRef}
          id={id}
          value={draft}
          autoComplete="off"
          maxLength={maxLength}
          placeholder={value.length === 0 ? placeholder : undefined}
          aria-describedby={[describedBy, countId].filter(Boolean).join(" ")}
          aria-invalid={hasError || undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            commitDraft();
            onBlur?.();
          }}
          className="h-6 min-w-[8rem] flex-1 bg-transparent px-1 text-control text-foreground outline-none placeholder:text-text-4"
        />
      </div>
      <div className="flex items-center gap-2">
        <span
          id={countId}
          className={cn(
            "text-small tabular-nums",
            value.length > max ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {value.length} of {max}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto"
          aria-expanded={bulkOpen}
          aria-controls={bulkOpen ? bulkId : undefined}
          onClick={() => setBulkOpen((open) => !open)}
        >
          <ListPlusIcon aria-hidden="true" />
          Paste a list
        </Button>
      </div>
      {bulkOpen ? (
        <div id={bulkId} className="flex flex-col gap-1.5">
          <Textarea
            aria-label={`Add ${noun}s, one per line`}
            value={bulk}
            rows={4}
            placeholder="One per line"
            className="max-h-48 font-mono text-[12px]"
            onChange={(event) => setBulk(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                addBulk();
              }
            }}
          />
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={() => setBulkOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={splitLines(bulk).length === 0}
              onClick={addBulk}
            >
              Add {splitLines(bulk).length || ""} {noun}
              {splitLines(bulk).length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
