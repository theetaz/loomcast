export interface FindPart {
  text: string;
  /** The index of the match among all matches, or null for text between matches. */
  match: number | null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits `text` around every case-insensitive occurrence of `query`. Matching runs on the text
 * itself, so offsets stay right for characters whose lowercase form has another length.
 */
export function findParts(text: string, query: string): FindPart[] {
  if (!query) return [{ text, match: null }];
  const pattern = new RegExp(escapeRegExp(query), "giu");
  const parts: FindPart[] = [];
  let from = 0;
  let count = 0;
  for (const found of text.matchAll(pattern)) {
    const at = found.index ?? 0;
    if (found[0].length === 0) continue;
    if (at > from) parts.push({ text: text.slice(from, at), match: null });
    parts.push({ text: found[0], match: count });
    count += 1;
    from = at + found[0].length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: null });
  return parts;
}

/** The number of matches in parts from `findParts`. */
export function matchCount(parts: readonly FindPart[]): number {
  return parts.reduce((sum, part) => sum + (part.match === null ? 0 : 1), 0);
}
