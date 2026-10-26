import { z } from "zod";

/** Lowercase ASCII letters and digits in groups joined by single hyphens. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SLUG_MAX_LENGTH = 64;

const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A workspace slug. Slugs shaped like a UUID are rejected, because routes such as
 * `/api/workspaces/:idOrSlug` accept either form.
 */
export const SlugSchema = z
  .string()
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_RE, { message: "Use lowercase letters, digits and single hyphens" })
  .refine((slug) => !UUID_SHAPE_RE.test(slug), { message: "A slug must not look like an id" });

const COMBINING_MARKS_RE = /\p{M}/gu;

/** Latin letters that Unicode normalisation does not split into a base letter and a mark. */
const LETTER_REPLACEMENTS: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
};
const REPLACEABLE_LETTERS_RE = new RegExp(`[${Object.keys(LETTER_REPLACEMENTS).join("")}]`, "g");
const NON_ALPHANUMERIC_RE = /[^a-z0-9]+/g;
const EDGE_HYPHENS_RE = /^-+|-+$/g;

/**
 * Turns free text into a slug: accents are removed, letters such as ß and æ are spelled out,
 * everything other than ASCII letters and digits becomes a single hyphen, and the result is cut to
 * `maxLength` without a trailing hyphen.
 *
 * Returns an empty string when nothing usable is left (for example, text without Latin letters or
 * digits), so the caller decides on a fallback.
 */
export function slugify(input: string, maxLength: number = SLUG_MAX_LENGTH): string {
  const slug = input
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .toLowerCase()
    .replace(REPLACEABLE_LETTERS_RE, (letter) => LETTER_REPLACEMENTS[letter] ?? "")
    .replace(NON_ALPHANUMERIC_RE, "-")
    .replace(EDGE_HYPHENS_RE, "");
  return slug.slice(0, maxLength).replace(EDGE_HYPHENS_RE, "");
}
