import { IdSchema, type PipelineState } from "@loomcast/contracts";
import { type Database, projects } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { type Executor, type Transaction, transaction } from "../../lib/db";
import { conflict, HttpError, validationFailed } from "../../lib/errors";

/**
 * Runs `fn` in the caller's transaction when there is one (its `afterCommit` callbacks then run
 * when that transaction commits), otherwise in a new one opened with `transaction()`.
 */
export function inTransaction<T>(
  db: Database,
  tx: Transaction | undefined,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return tx === undefined ? transaction(db, fn) : fn(tx);
}

export async function projectExists(executor: Executor, projectId: string): Promise<boolean> {
  if (!IdSchema.safeParse(projectId).success) {
    return false;
  }
  const [row] = await executor
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row !== undefined;
}

/** 409 `invalid_transition`: `PIPELINE_TRANSITIONS` has no row for the move. */
export function invalidTransition(from: PipelineState, to: PipelineState, message?: string) {
  return new HttpError(
    409,
    "invalid_transition",
    message ?? `An item cannot move from ${from} to ${to} this way.`,
    { from, to },
  );
}

/** 409 `conflict`: the client edited a version that is no longer the current one. */
export function staleVersion(currentVersionId: string) {
  return conflict("The item has a newer version. Reload it and try again.", {
    reason: "stale_version",
    currentVersionId,
  });
}

/** 422 `missing_artifact`: the move needs an artifact the version lacks. */
export function missingArtifact(message: string, artifact: string) {
  return new HttpError(422, "missing_artifact", message, { artifact });
}

/** Structural equality of JSON values, ignoring object key order (jsonb reorders keys). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => jsonEqual(value, b[index]));
  }
  const left = Object.entries(a).filter(([, value]) => value !== undefined);
  const right = Object.entries(b).filter(([, value]) => value !== undefined);
  if (left.length !== right.length) return false;
  const lookup = new Map(right);
  return left.every(([key, value]) => lookup.has(key) && jsonEqual(value, lookup.get(key)));
}

// Keyset cursors. A cursor is opaque base64url JSON; timestamps are fixed-format UTC text with
// microseconds, as Postgres stores them, so a page boundary never skips or repeats a row.

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export type CursorFields = Record<string, string | null>;

export function encodeCursor(fields: CursorFields): string {
  return Buffer.from(JSON.stringify(fields), "utf8").toString("base64url");
}

/**
 * Decodes a cursor with the given fields: `id` must be a UUID, every other field a timestamp
 * (or null where `nullable` lists it). 400 `validation_failed` otherwise.
 */
export function decodeCursor<K extends string>(
  cursor: string,
  keys: readonly K[],
  nullable: readonly K[] = [],
): Record<K, string | null> {
  const invalid = () => validationFailed([{ path: "cursor", message: "Unknown cursor" }]);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid();
  }
  const record = value as Record<string, unknown>;
  const result = {} as Record<K, string | null>;
  for (const key of keys) {
    const field = record[key];
    if (field === null && nullable.includes(key)) {
      result[key] = null;
    } else if (
      typeof field === "string" &&
      (key === "id" ? IdSchema.safeParse(field).success : TIMESTAMP_RE.test(field))
    ) {
      result[key] = field;
    } else {
      throw invalid();
    }
  }
  return result;
}

const serviceCache = new WeakMap<object, Map<string, unknown>>();

/**
 * One service instance per deps object (per app), built on first use. Modules registered later
 * (production, MCP tools, the scheduler) reach the pipeline services through the `…ServiceFor`
 * accessors without `createApp` having to wire them.
 */
export function serviceFor<T>(deps: object, name: string, create: () => T): T {
  let services = serviceCache.get(deps);
  if (services === undefined) {
    services = new Map();
    serviceCache.set(deps, services);
  }
  if (!services.has(name)) {
    services.set(name, create());
  }
  return services.get(name) as T;
}
