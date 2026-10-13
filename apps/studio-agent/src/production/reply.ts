import type { z } from "zod";
import { extractJsonBlock } from "../jobs/kb-analyze-reference";

/** A producer reply: the value of its first fenced JSON block, and the text around it. */
export type JsonReply<T> =
  | { readonly ok: true; readonly value: T; readonly rest: string }
  | { readonly ok: false; readonly problems: string[] };

/** Validates the first ```json block of a reply against `schema`. */
export function readJsonReply<S extends z.ZodType>(
  text: string,
  schema: S,
): JsonReply<z.output<S>> {
  const block = extractJsonBlock(text);
  if (block === null) {
    return { ok: false, problems: ["The reply has no fenced ```json code block."] };
  }
  let value: unknown;
  try {
    value = JSON.parse(block.json);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [`The JSON block is not valid JSON: ${truncate(reason, 300)}`] };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, problems: describeIssues(parsed.error.issues) };
  }
  return { ok: true, value: parsed.data, rest: block.rest.trim() };
}

/** At most 20 issues as `path: message` lines. */
export function describeIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string[] {
  const described = issues
    .slice(0, 20)
    .map(
      (issue) => `${issue.path.map(String).join(".") || "(root)"}: ${truncate(issue.message, 200)}`,
    );
  if (issues.length > described.length) {
    described.push(`…and ${issues.length - described.length} more problems`);
  }
  return described;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
