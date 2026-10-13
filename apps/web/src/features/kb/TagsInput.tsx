import { KB_MAX_TAGS, KbTagSchema } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";
import { XIcon } from "lucide-react";
import { type KeyboardEvent, useId, useRef, useState } from "react";

/**
 * Turns typed text into a tag: trimmed, lowercased, spaces become hyphens and a leading `#` is
 * dropped. Returns an error sentence when the result is not a valid tag.
 */
export function parseTag(text: string): { tag: string } | { error: string } {
  const candidate = text.trim().replace(/^#+/, "").replace(/\s+/g, "-").toLowerCase();
  const parsed = KbTagSchema.safeParse(candidate);
  return parsed.success
    ? { tag: parsed.data }
    : { error: "Tags use lowercase letters, digits and hyphens, up to 40 characters." };
}

export interface TagsInputProps {
  id?: string;
  value: readonly string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}

/**
 * Tags as removable chips before a text input. Enter or a comma adds what was typed; Backspace in
 * the empty input removes the last tag. Pasting `a, b, c` adds all three.
 */
export function TagsInput({ id, value, onChange, disabled = false }: TagsInputProps) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const full = value.length >= KB_MAX_TAGS;

  const add = (raw: string[]): boolean => {
    const next = [...value];
    for (const part of raw) {
      if (part.trim() === "") continue;
      const result = parseTag(part);
      if ("error" in result) {
        setError(result.error);
        return false;
      }
      if (next.includes(result.tag)) continue;
      if (next.length >= KB_MAX_TAGS) {
        setError(`An entry has at most ${KB_MAX_TAGS} tags.`);
        break;
      }
      next.push(result.tag);
    }
    if (next.length !== value.length) onChange(next);
    return true;
  };

  const commit = () => {
    if (text.trim() === "") return;
    if (add([text])) setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && text === "" && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
      setError(null);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the frame focuses the input; the input and buttons stay the keyboard targets. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above. */}
      <div
        onClick={(event) => {
          if (event.target === event.currentTarget) inputRef.current?.focus();
        }}
        className={cn(
          "flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md bg-card px-1.5 py-1 shadow-card transition-shadow",
          "focus-within:shadow-focus",
          error && "shadow-[0_0_0_1px_var(--destructive)]",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        {value.length > 0 ? (
          <ul aria-label="Tags" className="contents">
            {value.map((tag) => (
              <li
                key={tag}
                className="inline-flex h-6 items-center gap-0.5 rounded-full bg-secondary pr-0.5 pl-2 font-mono text-[11px] text-text-2 shadow-[0_0_0_1px_var(--border)]"
              >
                #{tag}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  disabled={disabled}
                  onClick={() => {
                    onChange(value.filter((item) => item !== tag));
                    inputRef.current?.focus();
                  }}
                  className="flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <XIcon aria-hidden="true" className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          ref={inputRef}
          id={inputId}
          value={text}
          disabled={disabled || full}
          autoComplete="off"
          spellCheck={false}
          placeholder={full ? "Tag limit reached" : value.length ? "Add another" : "Add a tag"}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${inputId}-hint`}
          className="h-6 min-w-24 flex-1 bg-transparent px-1 text-[13px] text-foreground outline-none placeholder:text-text-4"
          onChange={(event) => {
            const next = event.target.value;
            setError(null);
            if (next.includes(",")) {
              const parts = next.split(",");
              const rest = parts.pop() ?? "";
              if (add(parts)) setText(rest);
              else setText(next);
            } else {
              setText(next);
            }
          }}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
      </div>
      <p
        id={`${inputId}-hint`}
        className={cn("text-small", error ? "text-destructive" : "text-muted-foreground")}
      >
        {error ?? "Enter or comma adds a tag; Backspace removes the last one."}
      </p>
    </div>
  );
}
