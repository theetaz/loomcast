import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../src/client";
import {
  conversations,
  jobs,
  kbEntries,
  type NewApiTokenRow,
  type NewJobRow,
  type NewKbEntryRow,
  type NewUserRow,
  projects,
  users,
} from "../src/schema";

export async function insertUser(db: Database, overrides: Partial<NewUserRow> = {}) {
  const [user] = await db
    .insert(users)
    .values({
      email: `user-${randomUUID()}@example.com`,
      name: "Test User",
      passwordHash: "not-a-real-hash",
      role: "admin",
      ...overrides,
    })
    .returning();
  if (user === undefined) throw new Error("user was not inserted");
  return user;
}

export async function insertProject(db: Database, createdBy: string) {
  const [project] = await db
    .insert(projects)
    .values({ slug: `project-${randomUUID()}`, name: "Test Project", createdBy })
    .returning();
  if (project === undefined) throw new Error("project was not inserted");
  return project;
}

export async function insertConversation(db: Database, projectId: string, createdBy: string) {
  const [conversation] = await db
    .insert(conversations)
    .values({ projectId, createdBy })
    .returning();
  if (conversation === undefined) throw new Error("conversation was not inserted");
  return conversation;
}

type JobFixture = Pick<NewJobRow, "projectId" | "createdBy"> & Partial<NewJobRow>;

export function jobValues(values: JobFixture): NewJobRow {
  return { type: "system.ping", payload: {}, ...values };
}

export async function insertJob(db: Database, values: JobFixture) {
  const [job] = await db.insert(jobs).values(jobValues(values)).returning();
  if (job === undefined) throw new Error("job was not inserted");
  return job;
}

/** A random sha256 hex digest, standing in for the stored hash of a secret. */
export function randomHash(): string {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

type KbEntryFixture = Pick<NewKbEntryRow, "projectId"> & Partial<NewKbEntryRow>;

export async function insertKbEntry(db: Database, values: KbEntryFixture) {
  const [entry] = await db
    .insert(kbEntries)
    .values({ kind: "note", title: "Untitled entry", createdVia: "ui", ...values })
    .returning();
  if (entry === undefined) throw new Error("kb entry was not inserted");
  return entry;
}

type ApiTokenFixture = Pick<NewApiTokenRow, "userId" | "kind"> & Partial<NewApiTokenRow>;

/** Inserts a token row. The hash and prefix are random; no secret is involved. */
export function apiTokenValues(values: ApiTokenFixture): NewApiTokenRow {
  return {
    name: "test token",
    tokenHash: randomHash(),
    prefix: randomUUID().slice(0, 8),
    ...values,
  };
}

export interface PgErrorInfo {
  code: string | undefined;
  constraint: string | undefined;
}

/**
 * Awaits a query that must fail and returns the Postgres error code and constraint. Drizzle wraps
 * driver errors in `DrizzleQueryError`, so the driver error is read from `cause` when present.
 */
export async function pgError(query: PromiseLike<unknown>): Promise<PgErrorInfo> {
  try {
    await query;
  } catch (error) {
    const source = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const fields = source as { code?: string; constraint?: string };
    return { code: fields.code, constraint: fields.constraint };
  }
  throw new Error("expected the query to fail");
}

/** Postgres SQLSTATE codes used in assertions. */
export const PG = {
  uniqueViolation: "23505",
  checkViolation: "23514",
  notNullViolation: "23502",
} as const;
