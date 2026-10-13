/** A JSON value as stored in format rules. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * One difference between two JSON documents, at a dotted `path` such as `cadence.tz`.
 *
 * - `changed`: the value at `path` differs (`before` and `after` are set).
 * - `added` / `removed`: the key exists on one side only.
 * - `list`: a list of plain values gained (`added`) or lost (`removed`) entries, compared as sets,
 *   so reordering a topic list or adding one hashtag reads as what it is.
 */
export type JsonChange =
  | { kind: "changed"; path: string; before: Json; after: Json }
  | { kind: "added"; path: string; after: Json }
  | { kind: "removed"; path: string; before: Json }
  | { kind: "list"; path: string; added: Json[]; removed: Json[] };

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlain(value: Json): boolean {
  return value === null || typeof value !== "object";
}

function same(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function join(path: string, key: string | number): string {
  return path ? `${path}.${key}` : String(key);
}

function walk(before: Json | undefined, after: Json | undefined, path: string, out: JsonChange[]) {
  if (same(before, after)) return;
  if (before === undefined && after !== undefined) {
    out.push({ kind: "added", path, after });
    return;
  }
  if (after === undefined && before !== undefined) {
    out.push({ kind: "removed", path, before });
    return;
  }
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    for (const key of keys) walk(before[key], after[key], join(path, key), out);
    return;
  }
  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.every(isPlain) &&
    after.every(isPlain)
  ) {
    const had = new Set(before.map((value) => JSON.stringify(value)));
    const has = new Set(after.map((value) => JSON.stringify(value)));
    const added = after.filter((value) => !had.has(JSON.stringify(value)));
    const removed = before.filter((value) => !has.has(JSON.stringify(value)));
    if (added.length > 0 || removed.length > 0) {
      out.push({ kind: "list", path, added, removed });
    } else {
      // Same entries in another order.
      out.push({ kind: "changed", path, before, after });
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      walk(before[index], after[index], join(path, index), out);
    }
    return;
  }
  out.push({ kind: "changed", path, before: before as Json, after: after as Json });
}

/** Every difference from `before` to `after`, in the key order of the documents. */
export function diffJson(before: unknown, after: unknown): JsonChange[] {
  const out: JsonChange[] = [];
  walk(toJson(before), toJson(after), "", out);
  return out;
}

/** Drops `undefined` and anything else JSON can't hold, as the API would store it. */
export function toJson(value: unknown): Json | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Json;
}

/** A value for one line of the diff: strings quoted, lists and objects as compact JSON. */
export function formatJsonValue(value: Json): string {
  return JSON.stringify(value);
}
