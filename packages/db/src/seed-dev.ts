import { asc, eq } from "drizzle-orm";
import { isMainModule } from "./cli";
import { createDb, type Database } from "./client";
import { requireEnv } from "./env";
import { projects, users } from "./schema";

export const SAMPLE_PROJECT_SLUG = "sample-project";

export type SeedOutcome = "created" | "exists" | "no-owner";

/**
 * Creates a sample project owned by the first owner account. It never creates users: run
 * `pnpm admin:create` first. Safe to run repeatedly.
 */
export async function seedDev(db: Database): Promise<SeedOutcome> {
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "owner"))
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (owner === undefined) {
    return "no-owner";
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
  return inserted.length > 0 ? "created" : "exists";
}

const MESSAGES: Record<SeedOutcome, string> = {
  created: `Created project "${SAMPLE_PROJECT_SLUG}".`,
  exists: `Project "${SAMPLE_PROJECT_SLUG}" already exists.`,
  "no-owner": "No owner account yet. Run `pnpm admin:create` first, then seed again.",
};

async function main(): Promise<void> {
  const { db, close } = createDb(requireEnv("DATABASE_URL"), { max: 1 });
  try {
    console.log(MESSAGES[await seedDev(db)]);
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
