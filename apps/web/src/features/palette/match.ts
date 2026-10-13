/** Lowercase, accents removed, runs of whitespace collapsed. */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How well `query` matches an item: 0 for no match, higher for better ones.
 * An empty query matches everything equally. The label counts most: an exact
 * label, then a label prefix, then a word prefix, then a substring; otherwise
 * every word of the query must appear in the label or the keywords.
 */
export function matchScore(query: string, label: string, keywords: readonly string[] = []): number {
  const q = normalize(query);
  if (!q) return 1;
  const text = normalize(label);
  if (text === q) return 6;
  if (text.startsWith(q)) return 5;
  if (text.split(/[\s/._-]+/).some((word) => word.startsWith(q))) return 4;
  if (text.includes(q)) return 3;
  const haystack = [text, ...keywords.map(normalize)].join(" ");
  const terms = q.split(" ");
  if (terms.every((term) => haystack.includes(term))) return 2;
  return 0;
}

/**
 * The items that match `query`, best first; ties keep their original order.
 * `limit` caps the result.
 */
export function rankByMatch<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => { label: string; keywords?: readonly string[] },
  limit = Number.POSITIVE_INFINITY,
): T[] {
  return items
    .map((item, index) => {
      const { label, keywords } = text(item);
      return { item, index, score: matchScore(query, label, keywords) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}
