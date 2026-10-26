import { randomUUID } from "node:crypto";
import { CalendarGetSlotsOutputSchema } from "@loomcast/contracts";
import { auditLog, channels, scheduledPosts, seriesChannels, workspaces } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDeps, ModuleDeps } from "../src/deps";
import { createEventBus } from "../src/lib/bus";
import { createLifecycle } from "../src/lib/lifecycle";
import { createLogger } from "../src/lib/logger";
import { cadenceServiceFor } from "../src/modules/cadence";
import { formatsServiceFor } from "../src/modules/formats";
import { TOOL_CALL_AUDIT_ACTION } from "../src/modules/mcp";
import { seriesServiceFor } from "../src/modules/series";
import { type RunningServer, startServer } from "../src/server";
import { rulesWith } from "./calendar-support";
import { connectClient, issueJobToken, issueToken } from "./mcp-support";
import { createTestClock, insertUser, testConfig } from "./support";

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

const NOW = new Date("2026-10-12T00:00:00.000Z");
const RANGE = {
  from: NOW.toISOString(),
  to: new Date(NOW.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
};

let testDb: TestDb;
let running: RunningServer;
let moduleDeps: ModuleDeps;
let url: URL;
let userId: string;
let reader: Client;
let workspaceA: string;
let workspaceB: string;
let seriesA: string;
let seriesB: string;
let channelA: string;
const clients: Client[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
  const logger = createLogger({ level: "silent" });
  const deps: AppDeps = {
    db: testDb.db,
    bus: createEventBus(logger),
    clock: createTestClock(NOW),
    logger,
    config: testConfig({ trustProxy: false }),
    lifecycle: createLifecycle(logger),
  };
  running = await startServer(deps, {
    port: 0,
    host: "127.0.0.1",
    modules: [
      (app, captured) => {
        moduleDeps = captured;
        return app;
      },
    ],
  });
  url = new URL("/mcp", `http://127.0.0.1:${running.port}`);
  const user = await insertUser(testDb.db);
  userId = user.id;
  reader = await connectClient(url, (await issueToken(deps, userId, ["mcp:read"])).secret);
  workspaceA = await newWorkspace("Alpha");
  workspaceB = await newWorkspace("Beta");
  ({ seriesId: seriesA, channelId: channelA } = await plannedSeries(workspaceA, ["mon", "wed"]));
  ({ seriesId: seriesB } = await plannedSeries(workspaceB, ["tue"]));
});

afterAll(async () => {
  for (const client of [reader, ...clients]) {
    await client?.close();
  }
  await running?.close(1_000);
  await testDb?.drop();
});

async function newWorkspace(name: string): Promise<string> {
  const [workspace] = await testDb.db
    .insert(workspaces)
    .values({ slug: `mcp-calendar-${randomUUID().slice(0, 8)}`, name, createdBy: userId })
    .returning();
  if (workspace === undefined) throw new Error("workspace was not inserted");
  return workspace.id;
}

/** A series publishing at 09:00 UTC on `days`, on one channel, planned for the next two weeks. */
async function plannedSeries(workspaceId: string, days: ("mon" | "tue" | "wed")[]) {
  const actor = { kind: "user" as const, id: userId, userId };
  const format = await formatsServiceFor(moduleDeps).create(
    workspaceId,
    { name: "Daily", rules: rulesWith({ days, slots: ["09:00"], tz: "UTC", leadTimeHours: 1 }) },
    actor,
  );
  const series = await seriesServiceFor(moduleDeps).create(
    workspaceId,
    { name: "Daily", formatId: format.id },
    actor,
  );
  const [channel] = await testDb.db
    .insert(channels)
    .values({
      workspaceId,
      platform: "threads",
      displayName: `Channel ${randomUUID().slice(0, 6)}`,
    })
    .returning();
  if (channel === undefined) throw new Error("channel was not inserted");
  await testDb.db
    .insert(seriesChannels)
    .values({ workspaceId, seriesId: series.id, channelId: channel.id });
  await cadenceServiceFor(moduleDeps).plan(series.id);
  return { seriesId: series.id, channelId: channel.id };
}

function slotsOf(result: CallResult) {
  expect(result.isError).toBeFalsy();
  return CalendarGetSlotsOutputSchema.parse(result.structuredContent).slots;
}

function errorText(result: CallResult): string {
  expect(result.isError).toBe(true);
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? "";
}

async function jobClient(workspaceId: string): Promise<Client> {
  const issued = await issueJobToken(testDb.db, { userId, workspaceId, scopes: ["mcp:read"] });
  const client = await connectClient(url, issued.secret);
  clients.push(client);
  return client;
}

describe("calendar.get_slots", () => {
  it("lists the slots of every series in the range, with the post holding each", async () => {
    const result = await reader.callTool({ name: "calendar.get_slots", arguments: RANGE });
    const slots = slotsOf(result);
    expect(slots.map((slot) => `${slot.at} ${slot.seriesId === seriesA ? "A" : "B"}`)).toEqual([
      "2026-10-12T09:00:00.000Z A",
      "2026-10-13T09:00:00.000Z B",
      "2026-10-14T09:00:00.000Z A",
    ]);
    const posts = await testDb.db
      .select()
      .from(scheduledPosts)
      .where(eq(scheduledPosts.seriesId, seriesA));
    const monday = posts.find((post) => post.scheduledAt.toISOString() === slots[0]?.at);
    expect(slots[0]).toMatchObject({ seriesId: seriesA, channelId: channelA, postId: monday?.id });
    expect(result.content).toEqual([{ type: "text", text: "3 slots, 0 open." }]);
  });

  it("narrows by workspace, series and channel, and shows a cancelled post's slot as open", async () => {
    const byWorkspace = slotsOf(
      await reader.callTool({
        name: "calendar.get_slots",
        arguments: { ...RANGE, workspaceId: workspaceB },
      }),
    );
    expect(byWorkspace.map((slot) => slot.seriesId)).toEqual([seriesB]);
    const byChannel = slotsOf(
      await reader.callTool({
        name: "calendar.get_slots",
        arguments: { ...RANGE, channelId: channelA },
      }),
    );
    expect(byChannel).toHaveLength(2);

    const [wednesday] = await testDb.db
      .update(scheduledPosts)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(scheduledPosts.seriesId, seriesA),
          eq(scheduledPosts.scheduledAt, new Date("2026-10-14T09:00:00.000Z")),
        ),
      )
      .returning();
    const bySeries = slotsOf(
      await reader.callTool({
        name: "calendar.get_slots",
        arguments: { ...RANGE, seriesId: seriesA },
      }),
    );
    expect(bySeries.map((slot) => slot.postId === undefined)).toEqual([false, true]);
    await testDb.db
      .update(scheduledPosts)
      .set({ status: "planned" })
      .where(eq(scheduledPosts.id, wednesday?.id ?? ""));
  });

  it("holds a job token to its own workspace", async () => {
    const client = await jobClient(workspaceA);
    const own = slotsOf(await client.callTool({ name: "calendar.get_slots", arguments: RANGE }));
    expect(new Set(own.map((slot) => slot.seriesId))).toEqual(new Set([seriesA]));
    const foreign = await client.callTool({
      name: "calendar.get_slots",
      arguments: { ...RANGE, seriesId: seriesB },
    });
    expect(errorText(foreign)).toMatch(/^forbidden:/);
    const otherWorkspace = await client.callTool({
      name: "calendar.get_slots",
      arguments: { ...RANGE, workspaceId: workspaceB },
    });
    expect(errorText(otherWorkspace)).toMatch(/^forbidden:/);
    const [row] = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, TOOL_CALL_AUDIT_ACTION),
          eq(auditLog.targetId, "calendar.get_slots"),
        ),
      )
      .limit(1);
    expect(row).toBeDefined();
  });

  it("reports unknown series and ranges over 62 days", async () => {
    const unknown = await reader.callTool({
      name: "calendar.get_slots",
      arguments: { ...RANGE, seriesId: randomUUID() },
    });
    expect(errorText(unknown)).toMatch(/^not_found:/);
    const tooLong = await reader.callTool({
      name: "calendar.get_slots",
      arguments: {
        from: RANGE.from,
        to: new Date(NOW.getTime() + 63 * 24 * 60 * 60_000).toISOString(),
      },
    });
    expect(tooLong.isError).toBe(true);
  });
});
