import { splitKbSnippet } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";

/** The highlight of a matched part of text, shared by search snippets and find-in-text. */
export const MATCH_CLASS_NAME = "rounded-[3px] bg-accent-soft px-px text-foreground";

/**
 * A search snippet with its matches highlighted. The API marks matches with the `\u0002` and
 * `\u0003` sentinels instead of markup; the parts become text nodes and `<mark>` elements, so
 * stored text is never parsed as HTML.
 */
export function Snippet({ text, className }: { text: string; className?: string }) {
  const parts = splitKbSnippet(text);
  return (
    <span className={className}>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className={cn(MATCH_CLASS_NAME)}>
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}
