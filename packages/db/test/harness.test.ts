import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { projects } from "../src/schema";
import { seedDev } from "../src/seed-dev";
import { createTestDb, templateDatabaseName } from "../src/testing";
import { insertUser } from "./fixtures";

async function databaseExists(name: string): Promise<boolean> {
  const probe = await createTestDb({ empty: true, max: 1 });
  try {
    const result = await probe.db.execute(sql`select 1 from pg_database where datname = ${name}`);
    return result.rows.length > 0;
  } finally {
    await probe.drop();
  }
}

describe("createTestDb", () => {
  it("gives each caller its own migrated database and drops it afterwards", async () => {
    const one = await createTestDb();
    const two = await createTestDb();
    try {
      expect(one.name).toMatch(/^t_[0-9a-f_]+$/);
      expect(one.name).not.toBe(two.name);

      await insertUser(one.db, { email: "only-in-one@example.com" });
      const inTwo = await two.db.execute(sql`select count(*)::int as count from users`);
      expect(inTwo.rows[0]).toEqual({ count: 0 });
    } finally {
      await one.drop();
      await two.drop();
    }
    expect(await databaseExists(one.name)).toBe(false);
  });

  it("names the template after the migrations it was built from", async () => {
    const name = templateDatabaseName();
    expect(name).toMatch(/^loomcast_template_[0-9a-f]{12}$/);
    expect(await databaseExists(name)).toBe(true);
  });
});

describe("seedDev", () => {
  it("waits for an owner, then creates the sample project once", async () => {
    const testDb = await createTestDb({ max: 1 });
    try {
      expect(await seedDev(testDb.db)).toBe("no-owner");

      await insertUser(testDb.db, { role: "owner" });
      expect(await seedDev(testDb.db)).toBe("created");
      expect(await seedDev(testDb.db)).toBe("exists");
      expect(await testDb.db.select().from(projects)).toHaveLength(1);
    } finally {
      await testDb.drop();
    }
  });
});
