import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_FORMAT_RULES,
  type SkillFile,
  type SkillKind,
  skillChecksumInput,
} from "@loomcast/contracts";
import type { Database } from "../src/client";
import {
  type AssetMeta,
  contentItems,
  contentVersions,
  conversations,
  formats,
  formatVersions,
  jobs,
  kbEntries,
  type NewApiTokenRow,
  type NewAssetRow,
  type NewContentItemRow,
  type NewJobRow,
  type NewKbEntryRow,
  type NewUserRow,
  projects,
  skills,
  skillVersions,
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
  foreignKeyViolation: "23503",
} as const;

/** A database or a transaction: anything with the query builders. */
type Writer = Pick<Database, "insert">;

/** Inserts a format and its version 1 in one transaction, as the API does. */
export async function insertFormat(db: Database, projectId: string, createdBy?: string) {
  const formatId = randomUUID();
  const versionId = randomUUID();
  return db.transaction(async (tx) => {
    const [format] = await tx
      .insert(formats)
      .values({
        id: formatId,
        projectId,
        name: "Test Format",
        slug: `format-${formatId}`,
        currentVersionId: versionId,
      })
      .returning();
    const [version] = await tx
      .insert(formatVersions)
      .values({
        id: versionId,
        formatId,
        versionNo: 1,
        rules: structuredClone(DEFAULT_FORMAT_RULES),
        createdBy,
      })
      .returning();
    if (format === undefined || version === undefined) throw new Error("format was not inserted");
    return { format, version };
  });
}

type ContentItemFixture = Pick<NewContentItemRow, "projectId"> &
  Partial<Omit<NewContentItemRow, "id" | "currentVersionId">>;

/** Inserts a content item and its version 1 (the bare idea) through `db`, which may be a tx. */
export async function insertItemWith(db: Writer, values: ContentItemFixture) {
  const itemId = randomUUID();
  const versionId = randomUUID();
  const [item] = await db
    .insert(contentItems)
    .values({
      title: "Test Item",
      createdVia: "ui",
      ...values,
      id: itemId,
      currentVersionId: versionId,
    })
    .returning();
  const [version] = await db
    .insert(contentVersions)
    .values({ id: versionId, itemId, versionNo: 1, stage: "idea", createdVia: "system" })
    .returning();
  if (item === undefined || version === undefined) throw new Error("item was not inserted");
  return { item, version };
}

/** Inserts a content item and its version 1 in one transaction. */
export function insertContentItem(db: Database, values: ContentItemFixture) {
  return db.transaction((tx) => insertItemWith(tx, values));
}

type AssetFixture = Pick<NewAssetRow, "projectId"> & Partial<NewAssetRow>;

/** Asset values with a random storage key and SHA-256 (as stored: lowercase hex). */
export function assetValues(values: AssetFixture): NewAssetRow {
  const meta: AssetMeta = {};
  return {
    kind: "voice",
    bucket: "loomcast-media",
    storageKey: `test/${randomUUID()}`,
    filename: "take.mp3",
    mime: "audio/mpeg",
    bytes: 1024,
    sha256: randomHash(),
    meta,
    ...values,
  };
}

/** Skill files and their checksum, as the server computes it. */
export function skillFiles(label: string): { files: SkillFile[]; checksum: string } {
  const files: SkillFile[] = [
    { path: "SKILL.md", content: `# ${label}\n` },
    { path: "skill.json", content: JSON.stringify({ name: label, kind: "skill" }) },
  ];
  const checksum = createHash("sha256").update(skillChecksumInput(files), "utf8").digest("hex");
  return { files, checksum };
}

/** Publishes a skill with its version 1 in one transaction. */
export async function insertSkill(db: Database, name: string, kind: SkillKind = "skill") {
  const skillId = randomUUID();
  const versionId = randomUUID();
  const { files, checksum } = skillFiles(name);
  return db.transaction(async (tx) => {
    const [skill] = await tx
      .insert(skills)
      .values({ id: skillId, name, kind, currentVersionId: versionId })
      .returning();
    const [version] = await tx
      .insert(skillVersions)
      .values({ id: versionId, skillId, version: 1, files, checksum })
      .returning();
    if (skill === undefined || version === undefined) throw new Error("skill was not inserted");
    return { skill, version };
  });
}
