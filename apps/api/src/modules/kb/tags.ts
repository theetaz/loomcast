import { z } from "zod";

/**
 * A tag in lowercase kebab-case: `Rust Lang` and `rust_lang` both become `rust-lang`. Characters
 * other than letters, digits, spaces, hyphens and underscores are dropped, so the result may be
 * empty.
 */
export function normalizeTag(tag: string): string {
  return tag
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Normalised tags without empty ones or repeats, in their first-seen order. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized !== "") {
      seen.add(normalized);
    }
  }
  return [...seen];
}

/**
 * Wraps a request schema so a `tags` list of strings is normalised before it is validated. The
 * contracts accept only normalised tags; this lets the web app and scripts send `Rust Lang`.
 */
export function withNormalizedTags<S extends z.ZodType>(schema: S) {
  return z.preprocess((body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return body;
    }
    const tags = (body as { tags?: unknown }).tags;
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
      return body;
    }
    return { ...body, tags: normalizeTags(tags) };
  }, schema);
}
