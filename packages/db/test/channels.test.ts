import { randomBytes } from "node:crypto";
import { ChannelSchema } from "@loomcast/contracts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { channels, series, seriesChannels } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import {
  channelValues,
  insertActiveChannel,
  insertChannel,
  insertSeries,
  insertUser,
  insertWorkspace,
  PG,
  pgError,
  sealedSecret,
} from "./fixtures";

let testDb: TestDb;
/** The workspace of the channels whose workspace does not matter to the test. */
let workspaceId: string;

beforeAll(async () => {
  testDb = await createTestDb();
  const user = await insertUser(testDb.db);
  workspaceId = (await insertWorkspace(testDb.db, user.id)).id;
});

afterAll(async () => {
  await testDb.drop();
});

describe("channels", () => {
  it("start as a disconnected planning channel in dry-run without credentials", async () => {
    const user = await insertUser(testDb.db);
    const channel = await insertChannel(testDb.db, { workspaceId, createdBy: user.id });

    expect(channel).toMatchObject({
      status: "disconnected",
      dryRun: true,
      requiresApproval: false,
      externalId: null,
      parentChannelId: null,
      secretCiphertext: null,
      secretNonce: null,
      keyVersion: null,
      scopes: [],
      meta: {},
      disabledAt: null,
    });
  });

  it("store credentials only as ciphertext, nonce and key version, read back as bytes", async () => {
    const secret = sealedSecret(3);
    const channel = await insertActiveChannel(testDb.db, {
      workspaceId,
      ...secret,
      scopes: ["publish"],
    });

    expect(Buffer.isBuffer(channel.secretCiphertext)).toBe(true);
    expect(channel.secretCiphertext?.equals(secret.secretCiphertext)).toBe(true);
    expect(channel.secretNonce?.equals(secret.secretNonce)).toBe(true);
    expect(channel.keyVersion).toBe(3);

    const columns = await testDb.db.execute<{ column_name: string; data_type: string }>(
      sql`select column_name, data_type from information_schema.columns
          where table_name = 'channels' and column_name like '%secret%' order by column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: "secret_ciphertext", data_type: "bytea" },
      { column_name: "secret_nonce", data_type: "bytea" },
    ]);
  });

  it("parse into the contracts shape without the credential columns", async () => {
    const channel = await insertActiveChannel(testDb.db, { workspaceId });
    const dto = ChannelSchema.parse({
      ...channel,
      connected: channel.secretCiphertext !== null,
      liveBlocker: null,
      tokenExpiresAt: null,
      createdAt: channel.createdAt.toISOString(),
      updatedAt: channel.updatedAt.toISOString(),
      disabledAt: null,
    });

    expect(dto).not.toHaveProperty("secretCiphertext");
    expect(dto).not.toHaveProperty("secretNonce");
    expect(dto).not.toHaveProperty("keyVersion");
    expect(dto.connected).toBe(true);
  });

  it("set or clear the three credential columns together", async () => {
    const { secretCiphertext, secretNonce } = sealedSecret();
    const cases = [
      { secretCiphertext },
      { secretCiphertext, secretNonce },
      { secretNonce, keyVersion: 1 },
    ];
    for (const partial of cases) {
      expect(
        await pgError(
          testDb.db
            .insert(channels)
            .values(channelValues({ workspaceId, status: "needs_reauth", ...partial })),
        ),
      ).toEqual({ code: PG.checkViolation, constraint: "channels_secret_ck" });
    }
  });

  it("reject a nonce that is not 12 bytes, a ciphertext without a tag and key version 0", async () => {
    const values = (overrides: Partial<ReturnType<typeof sealedSecret>>) =>
      channelValues({ workspaceId, status: "active", ...sealedSecret(), ...overrides });

    expect(
      await pgError(testDb.db.insert(channels).values(values({ secretNonce: randomBytes(16) }))),
    ).toEqual({ code: PG.checkViolation, constraint: "channels_secret_nonce_ck" });
    expect(
      await pgError(
        testDb.db.insert(channels).values(values({ secretCiphertext: randomBytes(16) })),
      ),
    ).toEqual({ code: PG.checkViolation, constraint: "channels_secret_ciphertext_ck" });
    expect(await pgError(testDb.db.insert(channels).values(values({ keyVersion: 0 })))).toEqual({
      code: PG.checkViolation,
      constraint: "channels_key_version_ck",
    });
  });

  it("require credentials when active and forbid them when disconnected", async () => {
    expect(
      await pgError(
        testDb.db.insert(channels).values(channelValues({ workspaceId, status: "active" })),
      ),
    ).toEqual({ code: PG.checkViolation, constraint: "channels_status_secret_ck" });
    expect(
      await pgError(
        testDb.db
          .insert(channels)
          .values(channelValues({ workspaceId, status: "disconnected", ...sealedSecret() })),
      ),
    ).toEqual({ code: PG.checkViolation, constraint: "channels_status_secret_ck" });

    // Disconnecting wipes the credentials and the status in one update.
    const channel = await insertActiveChannel(testDb.db, { workspaceId });
    const [disconnected] = await testDb.db
      .update(channels)
      .set({ status: "disconnected", secretCiphertext: null, secretNonce: null, keyVersion: null })
      .where(eq(channels.id, channel.id))
      .returning();
    expect(disconnected?.status).toBe("disconnected");
    // Needing a new login or being disabled allows either.
    await insertChannel(testDb.db, { workspaceId, status: "needs_reauth" });
    await insertActiveChannel(testDb.db, {
      workspaceId,
      status: "disabled",
      disabledAt: new Date(),
    });
  });

  it("connect a platform account once, while planning channels share a null external id", async () => {
    const channel = await insertActiveChannel(testDb.db, { workspaceId, platform: "threads" });
    await insertChannel(testDb.db, { workspaceId, platform: "threads" });
    await insertChannel(testDb.db, { workspaceId, platform: "threads" });

    expect(
      await pgError(
        testDb.db.insert(channels).values(
          channelValues({
            workspaceId,
            platform: "threads",
            externalId: channel.externalId,
            status: "disabled",
          }),
        ),
      ),
    ).toEqual({ code: PG.uniqueViolation, constraint: "channels_platform_external_id_uq" });
    // The same id on another platform is another account.
    await insertChannel(testDb.db, {
      workspaceId,
      platform: "facebook",
      externalId: channel.externalId,
      status: "needs_reauth",
    });
  });

  it("link an instagram account to its facebook page, never to itself", async () => {
    const page = await insertActiveChannel(testDb.db, { workspaceId, platform: "facebook" });
    const account = await insertActiveChannel(testDb.db, {
      workspaceId,
      platform: "instagram",
      parentChannelId: page.id,
    });
    expect(account.parentChannelId).toBe(page.id);

    expect(
      await pgError(
        testDb.db
          .update(channels)
          .set({ parentChannelId: page.id })
          .where(eq(channels.id, page.id)),
      ),
    ).toEqual({ code: PG.checkViolation, constraint: "channels_parent_ck" });

    await testDb.db.delete(channels).where(eq(channels.id, page.id));
    const [orphan] = await testDb.db.select().from(channels).where(eq(channels.id, account.id));
    expect(orphan?.parentChannelId).toBeNull();
  });

  it("bump updated_at on update", async () => {
    const channel = await insertChannel(testDb.db, { workspaceId });
    const [updated] = await testDb.db
      .update(channels)
      .set({ requiresApproval: true })
      .where(eq(channels.id, channel.id))
      .returning();
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(channel.updatedAt.getTime());
    expect(updated?.requiresApproval).toBe(true);
  });

  it("reject an empty display name", async () => {
    expect(
      await pgError(
        testDb.db.insert(channels).values(channelValues({ workspaceId, displayName: "" })),
      ),
    ).toEqual({ code: PG.checkViolation, constraint: "channels_display_name_ck" });
  });
});

describe("series_channels", () => {
  it("link a channel to a series once, enabled by default", async () => {
    const user = await insertUser(testDb.db);
    const workspace = await insertWorkspace(testDb.db, user.id);
    const created = await insertSeries(testDb.db, workspace.id, user.id);
    const channel = await insertChannel(testDb.db, { workspaceId: workspace.id });
    const link = { workspaceId: workspace.id, seriesId: created.id, channelId: channel.id };

    const [inserted] = await testDb.db.insert(seriesChannels).values(link).returning();
    expect(inserted?.enabled).toBe(true);

    expect(
      await pgError(testDb.db.insert(seriesChannels).values({ ...link, enabled: false })),
    ).toEqual({ code: PG.uniqueViolation, constraint: "series_channels_pk" });
  });

  it("link only a series and a channel of the same workspace", async () => {
    const user = await insertUser(testDb.db);
    const workspace = await insertWorkspace(testDb.db, user.id);
    const other = await insertWorkspace(testDb.db, user.id);
    const created = await insertSeries(testDb.db, workspace.id, user.id);
    const channel = await insertChannel(testDb.db, { workspaceId: other.id });

    // Either workspace on the link leaves one of the two keys pointing nowhere.
    expect(
      await pgError(
        testDb.db
          .insert(seriesChannels)
          .values({ workspaceId: workspace.id, seriesId: created.id, channelId: channel.id }),
      ),
    ).toEqual({ code: PG.foreignKeyViolation, constraint: "series_channels_channel_fk" });
    expect(
      await pgError(
        testDb.db
          .insert(seriesChannels)
          .values({ workspaceId: other.id, seriesId: created.id, channelId: channel.id }),
      ),
    ).toEqual({ code: PG.foreignKeyViolation, constraint: "series_channels_series_fk" });
  });

  it("go away with the series or the channel", async () => {
    const user = await insertUser(testDb.db);
    const workspace = await insertWorkspace(testDb.db, user.id);
    const first = await insertSeries(testDb.db, workspace.id, user.id);
    const second = await insertSeries(testDb.db, workspace.id, user.id);
    const channel = await insertChannel(testDb.db, { workspaceId: workspace.id });
    const other = await insertChannel(testDb.db, { workspaceId: workspace.id });
    await testDb.db.insert(seriesChannels).values([
      { workspaceId: workspace.id, seriesId: first.id, channelId: channel.id },
      { workspaceId: workspace.id, seriesId: second.id, channelId: channel.id },
      { workspaceId: workspace.id, seriesId: second.id, channelId: other.id },
    ]);

    await testDb.db.delete(series).where(eq(series.id, first.id));
    await testDb.db.delete(channels).where(eq(channels.id, other.id));

    const links = await testDb.db
      .select()
      .from(seriesChannels)
      .where(sql`${seriesChannels.seriesId} in (${first.id}, ${second.id})`);
    expect(links.map((link) => [link.seriesId, link.channelId])).toEqual([[second.id, channel.id]]);
  });
});

describe("channel health", () => {
  it("starts empty, then records the last check, refusal and usage report", async () => {
    const channel = await insertActiveChannel(testDb.db, { workspaceId, platform: "facebook" });
    expect(channel).toMatchObject({ lastVerifiedAt: null, lastError: null, rateLimit: null });

    const verifiedAt = new Date(Date.UTC(2026, 9, 13, 3));
    const lastError = {
      code: "auth" as const,
      retryable: false,
      platformCode: "190",
      message: "The session was invalidated",
    };
    const rateLimit = { app: { call_count: 12, total_time: 3, total_cputime: 2 } };
    const [updated] = await testDb.db
      .update(channels)
      .set({ status: "needs_reauth", lastVerifiedAt: verifiedAt, lastError, rateLimit })
      .where(eq(channels.id, channel.id))
      .returning();
    expect(updated).toMatchObject({ lastVerifiedAt: verifiedAt, lastError, rateLimit });

    const dto = ChannelSchema.parse({
      ...updated,
      connected: true,
      liveBlocker: null,
      lastVerifiedAt: verifiedAt.toISOString(),
      createdAt: channel.createdAt.toISOString(),
      updatedAt: channel.updatedAt.toISOString(),
    });
    expect(dto.lastError).toEqual(lastError);
    expect(dto).not.toHaveProperty("rateLimit");
  });

  it("keeps the refusal and the usage report as JSON objects", async () => {
    const channel = await insertActiveChannel(testDb.db, { workspaceId });
    for (const [column, constraint] of [
      ["last_error", "channels_last_error_ck"],
      ["rate_limit", "channels_rate_limit_ck"],
    ] as const) {
      expect(
        await pgError(
          testDb.db.execute(
            sql`update channels set ${sql.identifier(column)} = '[]'::jsonb where id = ${channel.id}`,
          ),
        ),
      ).toEqual({ code: PG.checkViolation, constraint });
    }
  });
});
