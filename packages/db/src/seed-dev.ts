import { normalizeReferenceUrl } from "@loomcast/contracts";
import { asc, eq, sql } from "drizzle-orm";
import { isMainModule } from "./cli";
import { createDb, type Database } from "./client";
import { requireEnv } from "./env";
import { KB_FIXTURES } from "./fixtures/kb";
import { referenceSearchExtra } from "./queries/kb-search";
import { kbEntries, kbReferences, projects, users } from "./schema";

export const SAMPLE_PROJECT_SLUG = "sample-project";

/** Prefix of the dedupe keys of seeded knowledge-base entries. */
export const SEED_DEDUPE_PREFIX = "seed:";

const DAY_MS = 24 * 60 * 60_000;

export type SeedOutcome = "created" | "exists" | "no-owner";

export interface SeedResult {
  project: SeedOutcome;
  /** Knowledge-base entries inserted by this run; 0 when they were all there already. */
  kbEntriesCreated: number;
}

/**
 * Inserts the `KB_FIXTURES` entries into a project, skipping those already present (matched on
 * their `seed:<key>` dedupe key). A deleted fixture is inserted again. Returns how many were
 * inserted.
 */
export async function seedKb(
  db: Database,
  projectId: string,
  createdBy: string,
  now: Date = new Date(),
): Promise<number> {
  return db.transaction(async (tx) => {
    let created = 0;
    for (const fixture of KB_FIXTURES) {
      const updatedAt = new Date(now.getTime() - fixture.daysAgo * DAY_MS);
      const reference =
        fixture.reference === undefined
          ? undefined
          : { ...fixture.reference, ...normalizeReferenceUrl(fixture.reference.url) };
      const [entry] = await tx
        .insert(kbEntries)
        .values({
          projectId,
          kind: fixture.kind,
          title: fixture.title,
          bodyMd: fixture.bodyMd,
          tags: fixture.tags,
          data: fixture.data,
          sourceUrl: reference?.url ?? null,
          dedupeKey: `${SEED_DEDUPE_PREFIX}${fixture.key}`,
          searchExtra: reference === undefined ? "" : referenceSearchExtra(reference),
          createdBy,
          createdVia: "ui",
          createdAt: updatedAt,
          updatedAt,
        })
        .onConflictDoNothing({
          target: [kbEntries.projectId, kbEntries.dedupeKey],
          where: sql`${kbEntries.dedupeKey} is not null and ${kbEntries.deletedAt} is null`,
        })
        .returning({ id: kbEntries.id });
      if (entry === undefined) {
        continue;
      }
      created += 1;
      if (reference !== undefined) {
        await tx.insert(kbReferences).values({
          entryId: entry.id,
          url: reference.url,
          platform: reference.platform,
          author: reference.author,
          likedReason: reference.likedReason,
          transcript: reference.transcript ?? null,
          createdAt: updatedAt,
        });
      }
    }
    return created;
  });
}

/**
 * Creates a sample project owned by the first owner account and fills its knowledge base with
 * `KB_FIXTURES`. It never creates users: run `pnpm admin:create` first. Safe to run repeatedly.
 */
export async function seedDev(db: Database): Promise<SeedResult> {
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "owner"))
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (owner === undefined) {
    return { project: "no-owner", kbEntriesCreated: 0 };
  }
  const inserted = await db
    .insert(projects)
    .values({
      slug: SAMPLE_PROJECT_SLUG,
      name: "Sample project",
      description: "Created by the development seed.",
      createdBy: owner.id,
    })
    .onConflictDoNothing({ target: projects.slug })
    .returning({ id: projects.id });
  const [project] =
    inserted.length > 0
      ? inserted
      : await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.slug, SAMPLE_PROJECT_SLUG))
          .limit(1);
  if (project === undefined) {
    throw new Error(`Project "${SAMPLE_PROJECT_SLUG}" disappeared while seeding`);
  }
  return {
    project: inserted.length > 0 ? "created" : "exists",
    kbEntriesCreated: await seedKb(db, project.id, owner.id),
  };
}

const MESSAGES: Record<SeedOutcome, string> = {
  created: `Created project "${SAMPLE_PROJECT_SLUG}".`,
  exists: `Project "${SAMPLE_PROJECT_SLUG}" already exists.`,
  "no-owner": "No owner account yet. Run `pnpm admin:create` first, then seed again.",
};

async function main(): Promise<void> {
  const { db, close } = createDb(requireEnv("DATABASE_URL"), { max: 1 });
  try {
    const result = await seedDev(db);
    console.log(MESSAGES[result.project]);
    if (result.project !== "no-owner") {
      console.log(`Added ${result.kbEntriesCreated} knowledge-base entries.`);
    }
  } finally {
    await close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("Seeding failed:", error);
    process.exitCode = 1;
  });
}
