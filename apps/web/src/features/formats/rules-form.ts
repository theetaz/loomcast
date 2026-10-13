import { zodResolver } from "@hookform/resolvers/zod";
import {
  FormatNameSchema,
  type FormatRules,
  type FormatRulesInput,
  FormatRulesSchema,
} from "@loomcast/contracts";
import { type FieldErrors, get, type Resolver } from "react-hook-form";
import { z } from "zod";
import { ApiError } from "@/lib/api";

/** The format editor's values: the format's name and the rules of its next version. */
export interface FormatFormValues {
  name: string;
  rules: FormatRulesInput;
}

/** What a valid form submits, exactly as `formats.update` takes it. */
export interface FormatFormOutput {
  name: string;
  rules: FormatRules;
}

/** The contracts' schemas, so the editor accepts and refuses exactly what the API does. */
export const FormatFormSchema = z.object({ name: FormatNameSchema, rules: FormatRulesSchema });

function blank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * Turns the form's empty optional fields into missing ones, as the contracts expect them: an empty
 * voice, note, template or call to action is left out, not sent as `""`. A cleared voice speed (a
 * number input gives `NaN`) is left out too. Required numbers keep their `NaN`, so validation says
 * they need a value.
 */
export function normalizeRules(rules: FormatRulesInput): FormatRulesInput {
  const speed = rules.voiceSpeed;
  return withoutUndefined({
    ...rules,
    hookNotes: blank(rules.hookNotes),
    voiceId: blank(rules.voiceId),
    voiceSpeed: speed === undefined || speed === null || Number.isNaN(speed) ? undefined : speed,
    visualTemplate: withoutUndefined({
      ...rules.visualTemplate,
      templateId: blank(rules.visualTemplate.templateId),
    }),
    caption: withoutUndefined({ ...rules.caption, cta: blank(rules.caption.cta) }),
    recipe: rules.recipe?.name
      ? withoutUndefined({ name: rules.recipe.name, version: rules.recipe.version })
      : undefined,
  });
}

interface IssueLike {
  code?: string;
  expected?: string;
  input?: unknown;
  origin?: string;
  minimum?: unknown;
  maximum?: unknown;
}

/**
 * Plain-language messages for the generic checks (numbers, lengths, counts). Issues with their own
 * message in the contracts, such as the time zone or the length range, keep it.
 */
export function friendlyIssue(issue: IssueLike): string | undefined {
  const { code, origin } = issue;
  if (code === "invalid_type" && issue.expected === "number") return "Enter a number";
  if (code === "invalid_type" && issue.expected === "int") return "Use a whole number";
  if (code === "too_small") {
    const min = Number(issue.minimum);
    if (origin === "number") return `Use ${min} or more`;
    if (origin === "string") return min <= 1 ? "Required" : `Use at least ${min} characters`;
    if (origin === "array") return `Add at least ${min}`;
  }
  if (code === "too_big") {
    const max = Number(issue.maximum);
    if (origin === "number") return `Use ${max} or less`;
    if (origin === "string") return `Use at most ${max} characters`;
    if (origin === "array") return `Use at most ${max}`;
  }
  if (code === "invalid_value") return "Pick one of the options";
  return undefined;
}

const zodFormResolver = zodResolver(FormatFormSchema, {
  error: (issue: IssueLike) => friendlyIssue(issue),
});

/** Validates with the contracts after `normalizeRules`; errors land on the field they name. */
export const formatFormResolver: Resolver<FormatFormValues, unknown, FormatFormOutput> = (
  values,
  context,
  options,
) =>
  (zodFormResolver as unknown as Resolver<FormatFormValues, unknown, FormatFormOutput>)(
    { ...values, rules: normalizeRules(values.rules) },
    context,
    options,
  );

/** Form values for a stored version. The frozen defaults and cached rules are never edited in place. */
export function formValuesOf(name: string, rules: FormatRules): FormatFormValues {
  const copy = structuredClone(rules) as FormatRulesInput;
  // Text inputs hold "" when empty; starting from "" keeps an untouched form clean (not dirty).
  // `normalizeRules` turns them back into missing fields before anything is sent.
  return {
    name,
    rules: {
      ...copy,
      hookNotes: copy.hookNotes ?? "",
      voiceId: copy.voiceId ?? "",
      visualTemplate: { ...copy.visualTemplate, templateId: copy.visualTemplate.templateId ?? "" },
      caption: { ...copy.caption, cta: copy.caption.cta ?? "" },
    },
  };
}

/** A number input's value: empty is missing (left out), anything else a number (maybe NaN). */
export function optionalNumber(value: unknown): number | undefined {
  if (value === "" || value === undefined || value === null) return undefined;
  return typeof value === "number" ? value : Number(value);
}

/**
 * The message for a field, or for the first entry of a list field: `caption.hashtags` reports the
 * list's own error ("Hashtags must not repeat") or the first bad hashtag's.
 */
export function fieldError(errors: FieldErrors, name: string): string | undefined {
  const error = get(errors, name) as unknown;
  if (!error || typeof error !== "object") return undefined;
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && message) return message;
  const root = (error as { root?: { message?: unknown } }).root?.message;
  if (typeof root === "string" && root) return root;
  if (Array.isArray(error)) {
    for (const entry of error as unknown[]) {
      const nested = (entry as { message?: unknown } | undefined)?.message;
      if (typeof nested === "string" && nested) return nested;
    }
  }
  return undefined;
}

/** Indexes of list entries with an error of their own, such as one malformed hashtag. */
export function invalidEntries(errors: FieldErrors, name: string): Set<number> {
  const error = get(errors, name) as unknown;
  const found = new Set<number>();
  if (Array.isArray(error)) {
    (error as unknown[]).forEach((entry, index) => {
      if (entry) found.add(index);
    });
  }
  return found;
}

/** A form field named by an API issue path. List entries map onto their list. */
export function formPathOf(path: string): string | null {
  const parts = path.split(".").filter(Boolean);
  if (parts[0] !== "name" && parts[0] !== "rules") return null;
  const firstIndex = parts.findIndex((part) => /^\d+$/.test(part));
  return (firstIndex === -1 ? parts : parts.slice(0, firstIndex)).join(".");
}

/**
 * Field errors from a `400 validation_failed` answer, whose `details` list `{path, message}` per
 * issue (`rules.lengthSec.max`). Issues that name no form field are left out.
 */
export function serverFieldErrors(error: unknown): { name: string; message: string }[] {
  if (!(error instanceof ApiError) || error.code !== "validation_failed") return [];
  if (!Array.isArray(error.details)) return [];
  const found: { name: string; message: string }[] = [];
  for (const detail of error.details as unknown[]) {
    if (!detail || typeof detail !== "object") continue;
    const { path, message } = detail as { path?: unknown; message?: unknown };
    if (typeof path !== "string" || typeof message !== "string") continue;
    const name = formPathOf(path);
    if (name && !found.some((entry) => entry.name === name)) found.push({ name, message });
  }
  return found;
}
