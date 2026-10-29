import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { researchAccounts, researchVideoSnapshots, researchVideos } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import { insertUser, insertWorkspace, PG, pgError } from "./fixtures";

let testDb: TestDb;
let workspaceId: string;

beforeAll(async () => {
  testDb = await createTestDb();
  const user = await insertUser(testDb.db);
  workspaceId = (await insertWorkspace(testDb.db, user.id)).id;
});

afterAll(async () => {
  await testDb.drop();
});

async function insertAccount(handle: string) {
  const [row] = await testDb.db
    .insert(researchAccounts)
    .values({ workspaceId, platform: "instagram", handle, source: "tracked" })
    .returning();
  if (row === undefined) throw new Error("account was not inserted");
  return row;
}

describe("research tables", () => {
  it("keeps one account per workspace, platform and lowercased handle", async () => {
    await insertAccount("fireship");
    expect(await pgError(insertAccount("fireship"))).toEqual({
      code: PG.uniqueViolation,
      constraint: "research_accounts_workspace_id_platform_handle_uq",
    });
    expect(await pgError(insertAccount("FireShip"))).toEqual({
      code: PG.checkViolation,
      constraint: "research_accounts_handle_ck",
    });
    expect(
      await pgError(
        testDb.db
          .insert(researchAccounts)
          .values({ workspaceId, platform: "x" as "instagram", handle: "dev", source: "tracked" }),
      ),
    ).toEqual({ code: PG.checkViolation, constraint: "research_accounts_platform_ck" });
  });

  it("keeps one video per workspace, platform and external id, with non-negative counts", async () => {
    const account = await insertAccount("devtips");
    const values = {
      workspaceId,
      accountId: account.id,
      platform: "instagram" as const,
      externalId: "ABC123",
      source: "agent" as const,
      views: 10,
    };
    const [video] = await testDb.db.insert(researchVideos).values(values).returning();
    expect(video?.tags).toEqual([]);
    expect(await pgError(testDb.db.insert(researchVideos).values(values))).toEqual({
      code: PG.uniqueViolation,
      constraint: "research_videos_workspace_id_platform_external_id_uq",
    });
    expect(
      await pgError(
        testDb.db.insert(researchVideos).values({ ...values, externalId: "NEG", views: -1 }),
      ),
    ).toEqual({ code: PG.checkViolation, constraint: "research_videos_counts_ck" });
    expect(
      await pgError(
        testDb.db
          .insert(researchVideos)
          .values({ ...values, externalId: "SRC", source: "scraped" as "agent" }),
      ),
    ).toEqual({ code: PG.checkViolation, constraint: "research_videos_source_ck" });

    // Deleting the account deletes its videos and their snapshots.
    if (video === undefined) throw new Error("video was not inserted");
    await testDb.db.insert(researchVideoSnapshots).values({ videoId: video.id, views: 10 });
    await testDb.db.delete(researchAccounts).where(eq(researchAccounts.id, account.id));
    expect(
      await testDb.db
        .select()
        .from(researchVideoSnapshots)
        .where(eq(researchVideoSnapshots.videoId, video.id)),
    ).toEqual([]);
  });
});
