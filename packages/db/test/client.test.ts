import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { createTestDb } from "../src/testing";

describe("createDb", () => {
  it("survives an idle connection being terminated by the server", async () => {
    const testDb = await createTestDb({ empty: true, max: 1 });
    const errors: Error[] = [];
    const handle = createDb(testDb.url, { max: 1, onError: (error) => errors.push(error) });
    try {
      const before = await handle.db.execute(sql`select pg_backend_pid() as pid`);
      const pid = Number(before.rows[0]?.pid);

      // The connection is idle in the pool now; end it from another session.
      await testDb.db.execute(sql`select pg_terminate_backend(${pid})`);
      await expect.poll(() => errors.length, { timeout: 5000 }).toBeGreaterThan(0);

      const after = await handle.db.execute(sql`select 1 as ok`);
      expect(after.rows[0]).toEqual({ ok: 1 });
    } finally {
      await handle.close();
      await testDb.drop();
    }
  });
});
