// Text that ends up in generated HTML always goes through these helpers. Slot text, hooks and
// captions come from producer sessions and reviewers, so nothing they write is ever parsed as
// markup, with one exception: balanced `<em>` emphasis in rich-text slots.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for use in HTML content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/**
 * Escapes rich-text slot content, keeping only plain, non-nested `<em>…</em>` pairs as markup.
 * Anything else, including `<em>` with attributes or unbalanced tags, is escaped as text.
 */
export function escapeRichText(text: string): string {
  const parts = text.split(/(<\/?em>)/);
  let open = false;
  for (const part of parts) {
    if (part === "<em>") {
      if (open) return escapeHtml(text);
      open = true;
    } else if (part === "</em>") {
      if (!open) return escapeHtml(text);
      open = false;
    }
  }
  if (open) return escapeHtml(text);
  return parts
    .map((part) => (part === "<em>" || part === "</em>" ? part : escapeHtml(part)))
    .join("");
}

/** Text safe to place inside an inline `<script>` or `<style>` element. */
export function guardRawText(text: string): string {
  return text.replace(/<\/(script|style)/gi, "<\\/$1");
}

/** Formats milliseconds as seconds for `data-start` and `data-duration`. */
export function secondsAttr(ms: number): string {
  return (Math.round(ms) / 1000).toFixed(3).replace(/\.?0+$/, "") || "0";
}
