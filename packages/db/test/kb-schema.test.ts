import {
  ACTOR_KINDS,
  ASSET_KINDS,
  ASSET_STATUSES,
  CHANNEL_STATUSES,
  CONTENT_CREATED_VIA,
  JOB_STATUSES,
  JOB_TYPES,
  KB_CREATED_VIA,
  KB_ENTRY_KINDS,
  MESSAGE_ROLES,
  OAUTH_PROVIDERS,
  PASSWORD_TOKEN_PURPOSES,
  PIPELINE_STATES,
  PLATFORMS,
  POST_STATUSES,
  PRODUCE_TARGETS,
  PROJECT_STATUSES,
  REFERENCE_PLATFORMS,
  REVIEW_DECISIONS,
  SERIES_STATUSES,
  SKILL_KINDS,
  TASK_STATUSES,
  TOKEN_KINDS,
  TOKEN_SCOPES,
  USER_ROLES,
  VERSION_CREATED_VIA,
} from "@loomcast/contracts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiTokens, jobs, kbEntries, kbReferences, passwordTokens, users } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import {
  apiTokenValues,
  insertJob,
  insertKbEntry,
  insertProject,
  insertUser,
  PG,
  pgError,
  randomHash,
} from "./fixtures";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

async function setup() {
  const user = await insertUser(testDb.db);
  const project = await insertProject(testDb.db, user.id);
  return { user, project };
}

async function searchVector(id: string): Promise<string> {
  const [row] = await testDb.db
    .select({ search: kbEntries.search })
    .from(kbEntries)
    .where(eq(kbEntries.id, id));
  return row?.search ?? "";
}

/** The weight a lexeme carries in a tsvector's text form (`'rust':1A`), or undefined. */
function weightOf(vector: string, lexeme: string): string | undefined {
  const match = new RegExp(`'${lexeme}':([0-9,ABCD]+)`).exec(vector);
  if (match?.[1] === undefined) return undefined;
  // Postgres omits the weight letter for D.
  return /[ABC]$/.exec(match[1])?.[0] ?? "D";
}

describe("kb_entries.search", () => {
  it("weights title, tags, body and search_extra, and follows every change", async () => {
    const { project } = await setup();
    const entry = await insertKbEntry(testDb.db, {
      projectId: project.id,
      title: "Rust walkthrough",
      tags: ["graphql"],
      bodyMd: "A zebra crossing.",
      searchExtra: "pelican",
    });

    let vector = await searchVector(entry.id);
    expect(weightOf(vector, "rust")).toBe("A");
    expect(weightOf(vector, "graphql")).toBe("B");
    expect(weightOf(vector, "zebra")).toBe("C");
    expect(weightOf(vector, "pelican")).toBe("D");

    await testDb.db
      .update(kbEntries)
      .set({ title: "Walrus walkthrough" })
      .where(eq(kbEntries.id, entry.id));
    vector = await searchVector(entry.id);
    expect(weightOf(vector, "rust")).toBeUndefined();
    expect(weightOf(vector, "walrus")).toBe("A");

    await testDb.db
      .update(kbEntries)
      .set({ tags: ["otter", "kotlin"] })
      .where(eq(kbEntries.id, entry.id));
    vector = await searchVector(entry.id);
    expect(weightOf(vector, "graphql")).toBeUndefined();
    expect(weightOf(vector, "otter")).toBe("B");
    expect(weightOf(vector, "kotlin")).toBe("B");

    await testDb.db.update(kbEntries).set({ bodyMd: "A llama." }).where(eq(kbEntries.id, entry.id));
    vector = await searchVector(entry.id);
    expect(weightOf(vector, "zebra")).toBeUndefined();
    expect(weightOf(vector, "llama")).toBe("C");
  });

  it("lowercases tags", async () => {
    const { project } = await setup();
    const entry = await insertKbEntry(testDb.db, { projectId: project.id, tags: ["GraphQL"] });
    expect(weightOf(await searchVector(entry.id), "graphql")).toBe("B");
  });

  it("cannot be written", async () => {
    const { project } = await setup();
    const error = await pgError(
      testDb.db.execute(
        sql`insert into kb_entries (project_id, kind, title, created_via, search)
            values (${project.id}, 'note', 'x', 'ui', to_tsvector('x'))`,
      ),
    );
    expect(error.code).toBe("428C9"); // generated_always
  });
});

describe("kb_entries constraints", () => {
  it("limits titles to 300 characters", async () => {
    const { project } = await setup();
    await insertKbEntry(testDb.db, { projectId: project.id, title: "t".repeat(300) });
    const error = await pgError(
      insertKbEntry(testDb.db, { projectId: project.id, title: "t".repeat(301) }),
    );
    expect(error).toEqual({ code: PG.checkViolation, constraint: "kb_entries_title_length_ck" });
  });

  it("keeps dedupe keys unique among the live entries of a project", async () => {
    const { user, project } = await setup();
    const other = await insertProject(testDb.db, user.id);
    const first = await insertKbEntry(testDb.db, { projectId: project.id, dedupeKey: "key-1" });

    const error = await pgError(
      insertKbEntry(testDb.db, { projectId: project.id, dedupeKey: "key-1" }),
    );
    expect(error).toEqual({
      code: PG.uniqueViolation,
      constraint: "kb_entries_project_id_dedupe_key_uq",
    });

    // Another project may use the key, and entries without a key never conflict.
    await insertKbEntry(testDb.db, { projectId: other.id, dedupeKey: "key-1" });
    await insertKbEntry(testDb.db, { projectId: project.id });
    await insertKbEntry(testDb.db, { projectId: project.id });

    // Deleting the entry frees its key.
    await testDb.db
      .update(kbEntries)
      .set({ deletedAt: new Date() })
      .where(eq(kbEntries.id, first.id));
    await insertKbEntry(testDb.db, { projectId: project.id, dedupeKey: "key-1" });

    // The insert-or-skip pattern the API and the seed use.
    const skipped = await testDb.db
      .insert(kbEntries)
      .values({
        projectId: project.id,
        kind: "note",
        title: "Again",
        createdVia: "ui",
        dedupeKey: "key-1",
      })
      .onConflictDoNothing({
        target: [kbEntries.projectId, kbEntries.dedupeKey],
        where: sql`${kbEntries.dedupeKey} is not null and ${kbEntries.deletedAt} is null`,
      })
      .returning({ id: kbEntries.id });
    expect(skipped).toEqual([]);
  });

  it("defaults tags, data, body and search_extra, and bumps updated_at on update", async () => {
    const { project } = await setup();
    const entry = await insertKbEntry(testDb.db, { projectId: project.id });
    expect(entry).toMatchObject({
      tags: [],
      data: {},
      bodyMd: "",
      searchExtra: "",
      deletedAt: null,
    });

    const [updated] = await testDb.db
      .update(kbEntries)
      .set({ title: "Renamed" })
      .where(eq(kbEntries.id, entry.id))
      .returning({ updatedAt: kbEntries.updatedAt });
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(entry.updatedAt.getTime());
  });
});

describe("kb_references", () => {
  async function referenceEntry() {
    const { user, project } = await setup();
    const entry = await insertKbEntry(testDb.db, { projectId: project.id, kind: "reference" });
    return { user, project, entry };
  }

  it("defaults the analysis status to none and rejects unknown statuses", async () => {
    const { entry } = await referenceEntry();
    const [reference] = await testDb.db
      .insert(kbReferences)
      .values({ entryId: entry.id, url: "https://example.com/v/1", platform: "other" })
      .returning();
    expect(reference?.analysisStatus).toBe("none");

    const error = await pgError(
      testDb.db.execute(
        sql`update kb_references set analysis_status = 'pending' where entry_id = ${entry.id}`,
      ),
    );
    expect(error).toEqual({
      code: PG.checkViolation,
      constraint: "kb_references_analysis_status_ck",
    });
  });

  it("is deleted with its entry, and keeps its analysis when the job is deleted", async () => {
    const { user, project, entry } = await referenceEntry();
    const job = await insertJob(testDb.db, {
      projectId: project.id,
      createdBy: user.id,
      type: "kb.analyze_reference",
    });
    await testDb.db.insert(kbReferences).values({
      entryId: entry.id,
      url: "https://example.com/v/2",
      platform: "other",
      analysisStatus: "queued",
      analysisJobId: job.id,
    });

    await testDb.db.delete(jobs).where(eq(jobs.id, job.id));
    const [reference] = await testDb.db
      .select()
      .from(kbReferences)
      .where(eq(kbReferences.entryId, entry.id));
    expect(reference).toMatchObject({ analysisJobId: null, analysisStatus: "queued" });

    await testDb.db.delete(kbEntries).where(eq(kbEntries.id, entry.id));
    const left = await testDb.db
      .select()
      .from(kbReferences)
      .where(eq(kbReferences.entryId, entry.id));
    expect(left).toEqual([]);
  });
});

describe("api_tokens job binding", () => {
  it("requires a job id on job tokens and forbids it on every other kind", async () => {
    const { user, project } = await setup();
    const job = await insertJob(testDb.db, { projectId: project.id, createdBy: user.id });

    const unbound = await pgError(
      testDb.db.insert(apiTokens).values(apiTokenValues({ userId: user.id, kind: "job" })),
    );
    expect(unbound).toEqual({ code: PG.checkViolation, constraint: "api_tokens_job_id_ck" });

    for (const kind of ["mcp", "device"] as const) {
      const bound = await pgError(
        testDb.db
          .insert(apiTokens)
          .values(apiTokenValues({ userId: user.id, kind, jobId: job.id })),
      );
      expect(bound).toEqual({ code: PG.checkViolation, constraint: "api_tokens_job_id_ck" });
    }

    await testDb.db
      .insert(apiTokens)
      .values(apiTokenValues({ userId: user.id, kind: "mcp", scopes: ["mcp:read"] }));
    const [token] = await testDb.db
      .insert(apiTokens)
      .values(
        apiTokenValues({
          userId: user.id,
          kind: "job",
          projectId: project.id,
          jobId: job.id,
          scopes: ["mcp:read", "mcp:write"],
        }),
      )
      .returning();
    expect(token).toMatchObject({ kind: "job", projectId: project.id, jobId: job.id });
  });

  it("deletes a job token together with its job", async () => {
    const { user, project } = await setup();
    const job = await insertJob(testDb.db, { projectId: project.id, createdBy: user.id });
    const [token] = await testDb.db
      .insert(apiTokens)
      .values(
        apiTokenValues({ userId: user.id, kind: "job", projectId: project.id, jobId: job.id }),
      )
      .returning();
    // An entry written with the token keeps existing, without the token reference.
    const entry = await insertKbEntry(testDb.db, {
      projectId: project.id,
      createdVia: "producer",
      createdBy: user.id,
      createdByTokenId: token?.id ?? null,
    });

    await testDb.db.delete(jobs).where(eq(jobs.id, job.id));

    expect(await testDb.db.select().from(apiTokens).where(eq(apiTokens.jobId, job.id))).toEqual([]);
    const [kept] = await testDb.db.select().from(kbEntries).where(eq(kbEntries.id, entry.id));
    expect(kept?.createdByTokenId).toBeNull();
  });
});

describe("password_tokens", () => {
  it("lets an invited user exist without a password", async () => {
    const user = await insertUser(testDb.db, { passwordHash: null });
    expect(user.passwordHash).toBeNull();
  });

  it("keeps token hashes unique and is deleted with its user", async () => {
    const owner = await insertUser(testDb.db, { role: "owner" });
    const invited = await insertUser(testDb.db, { passwordHash: null });
    const tokenHash = randomHash();
    const values = {
      userId: invited.id,
      tokenHash,
      purpose: "invite" as const,
      createdBy: owner.id,
      expiresAt: new Date(Date.now() + 60_000),
    };

    await testDb.db.insert(passwordTokens).values(values);
    const error = await pgError(testDb.db.insert(passwordTokens).values(values));
    expect(error).toEqual({
      code: PG.uniqueViolation,
      constraint: "password_tokens_token_hash_uq",
    });

    await testDb.db.delete(users).where(eq(users.id, invited.id));
    expect(
      await testDb.db.select().from(passwordTokens).where(eq(passwordTokens.tokenHash, tokenHash)),
    ).toEqual([]);
  });
});

describe("pg enums", () => {
  const ENUMS: Record<string, readonly string[]> = {
    user_role: USER_ROLES,
    token_kind: TOKEN_KINDS,
    token_scope: TOKEN_SCOPES,
    project_status: PROJECT_STATUSES,
    job_type: JOB_TYPES,
    job_status: JOB_STATUSES,
    message_role: MESSAGE_ROLES,
    actor_kind: ACTOR_KINDS,
    kb_entry_kind: KB_ENTRY_KINDS,
    kb_created_via: KB_CREATED_VIA,
    reference_platform: REFERENCE_PLATFORMS,
    password_token_purpose: PASSWORD_TOKEN_PURPOSES,
    series_status: SERIES_STATUSES,
    pipeline_state: PIPELINE_STATES,
    produce_target: PRODUCE_TARGETS,
    content_created_via: CONTENT_CREATED_VIA,
    version_created_via: VERSION_CREATED_VIA,
    review_decision: REVIEW_DECISIONS,
    asset_kind: ASSET_KINDS,
    asset_status: ASSET_STATUSES,
    skill_kind: SKILL_KINDS,
    platform: PLATFORMS,
    channel_status: CHANNEL_STATUSES,
    post_status: POST_STATUSES,
    task_status: TASK_STATUSES,
    oauth_provider: OAUTH_PROVIDERS,
  };

  it("hold exactly the contracts values, in order", async () => {
    const result = await testDb.db.execute<{ typname: string; labels: string[] }>(
      sql`select typname, array_agg(enumlabel::text order by enumsortorder) as labels
          from pg_enum join pg_type on pg_type.oid = pg_enum.enumtypid
          group by typname`,
    );
    const actual = Object.fromEntries(result.rows.map((row) => [row.typname, row.labels]));
    expect(actual).toEqual(Object.fromEntries(Object.entries(ENUMS).map(([k, v]) => [k, [...v]])));
  });

  it("accept the values added after M1", async () => {
    const { user, project } = await setup();
    const job = await insertJob(testDb.db, {
      projectId: project.id,
      createdBy: user.id,
      type: "kb.analyze_reference",
    });
    expect(job.type).toBe("kb.analyze_reference");
  });
});
