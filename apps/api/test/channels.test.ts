import { randomUUID } from "node:crypto";
import {
  type Channel,
  ChannelSchema,
  FormatSchema,
  type SeriesChannels,
  SeriesChannelsSchema,
  SeriesSchema,
} from "@loomcast/contracts";
import { auditLog, scheduledTasks, series } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModuleDeps } from "../src/deps";
import {
  call,
  createPipelineHarness,
  eventsOf,
  insertWorkspace,
  type PipelineHarness,
} from "./pipeline-support";
import { appWith, insertChannel, testKeyring } from "./publisher-support";
import { errorCode, send, type TestApp } from "./support";

let h: PipelineHarness;
let workspaceId: string;
const keyring = testKeyring();
/** A second app on the same database whose server publishes live. */
let live: { t: TestApp; deps: ModuleDeps };

beforeAll(async () => {
  h = await createPipelineHarness();
  workspaceId = await insertWorkspace(h);
  live = appWith(h.db, {
    clock: h.t.clock,
    config: { publishing: { mode: "live", enabled: true }, encryption: keyring },
  });
});

afterAll(async () => {
  await live.t.deps.lifecycle.close();
  await h.close();
});

function channelsPath(workspace = workspaceId): string {
  return `/api/workspaces/${workspace}/channels`;
}

async function createChannel(body: unknown, workspace = workspaceId): Promise<Response> {
  return call(h, "POST", channelsPath(workspace), body);
}

async function listed(workspace = workspaceId): Promise<Channel[]> {
  const response = await call(h, "GET", channelsPath(workspace));
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: Channel[] }).items;
}

async function patch(id: string, body: unknown, app: TestApp = h.t): Promise<Response> {
  return send(app.app, "PATCH", `/api/channels/${id}`, { cookie: h.cookie, body });
}

async function audits(targetId: string) {
  return h.db.select().from(auditLog).where(eq(auditLog.targetId, targetId));
}

async function newSeries(): Promise<string> {
  const format = await call(h, "POST", `/api/workspaces/${workspaceId}/formats`, {
    name: `Format ${randomUUID().slice(0, 6)}`,
  });
  expect(format.status).toBe(201);
  const formatId = FormatSchema.parse(await format.json()).id;
  const created = await call(h, "POST", `/api/workspaces/${workspaceId}/series`, {
    name: `Series ${randomUUID().slice(0, 6)}`,
    formatId,
  });
  expect(created.status).toBe(201);
  return SeriesSchema.parse(await created.json()).id;
}

describe("channels", () => {
  it("adds a planning channel: disconnected, dry-run, audited and published", async () => {
    const response = await createChannel({
      platform: "instagram",
      displayName: "  Loomcast IG  ",
      requiresApproval: true,
    });
    expect(response.status).toBe(201);
    const channel = ChannelSchema.parse(await response.json());
    expect(channel).toMatchObject({
      platform: "instagram",
      displayName: "Loomcast IG",
      status: "disconnected",
      dryRun: true,
      requiresApproval: true,
      connected: false,
      externalId: null,
      scopes: [],
      liveBlocker: "not_connected",
    });
    expect((await audits(channel.id)).map((row) => row.action)).toEqual(["channel.created"]);
    expect(
      eventsOf(h.live, "channel.updated").some((event) => event.payload.channel.id === channel.id),
    ).toBe(true);
  });

  it("validates new channels", async () => {
    expect(await errorCode(await createChannel({ platform: "tiktok", displayName: "A" }))).toBe(
      "validation_failed",
    );
    expect(await errorCode(await createChannel({ platform: "threads", displayName: " " }))).toBe(
      "validation_failed",
    );
  });

  it("lists channels without credentials", async () => {
    const connected = await insertChannel(h.db, keyring, {
      workspaceId,
      platform: "facebook",
      connected: true,
    });
    const response = await call(h, "GET", channelsPath());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(connected.token ?? "");
    expect(text).not.toMatch(/secret|ciphertext|nonce|keyVersion|accessToken/i);
    const { items } = JSON.parse(text) as { items: Channel[] };
    const found = items.find((item) => item.id === connected.id);
    expect(found).toMatchObject({
      connected: true,
      status: "active",
      externalId: connected.externalId,
    });
    const allowed = new Set(Object.keys(ChannelSchema.shape));
    expect(Object.keys(found ?? {}).filter((key) => !allowed.has(key))).toEqual([]);
  });

  it("renames and changes approval, auditing each change", async () => {
    const created = ChannelSchema.parse(
      await (await createChannel({ platform: "threads", displayName: "Threads" })).json(),
    );
    const response = await patch(created.id, {
      displayName: "Threads main",
      requiresApproval: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      displayName: "Threads main",
      requiresApproval: true,
    });
    const updated = (await audits(created.id)).find((row) => row.action === "channel.updated");
    expect(updated?.data).toEqual({
      changes: {
        displayName: { from: "Threads", to: "Threads main" },
        requiresApproval: { from: false, to: true },
      },
    });
    expect((await patch(created.id, { displayName: "Threads main" })).status).toBe(200);
    expect(
      (await audits(created.id)).filter((row) => row.action === "channel.updated"),
    ).toHaveLength(1);
  });

  it("refuses unknown channels and empty updates", async () => {
    expect((await patch(randomUUID(), { displayName: "X" })).status).toBe(404);
    const created = ChannelSchema.parse(
      await (await createChannel({ platform: "facebook", displayName: "Page" })).json(),
    );
    expect(await errorCode(await patch(created.id, {}))).toBe("validation_failed");
  });

  it("locks dry-run off with the blocker as the reason", async () => {
    const cases = [
      { spec: { platform: "instagram" as const }, app: live.t, reason: "not_connected" },
      {
        spec: { platform: "instagram" as const, connected: true, status: "needs_reauth" as const },
        app: live.t,
        reason: "not_active",
      },
      {
        spec: { platform: "facebook" as const, connected: true, status: "disabled" as const },
        app: live.t,
        reason: "not_active",
      },
      {
        spec: { platform: "x" as const, connected: true },
        app: live.t,
        reason: "platform_unavailable",
      },
      // Active and connected, but the server publishes in dry-run.
      {
        spec: { platform: "threads" as const, connected: true },
        app: h.t,
        reason: "publishing_dry_run",
      },
    ];
    for (const { spec, app, reason } of cases) {
      const channel = await insertChannel(h.db, keyring, { ...spec, workspaceId });
      const response = await patch(channel.id, { dryRun: false }, app);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: "dry_run_locked",
          message: expect.any(String),
          details: { reason },
        },
      });
      const list = (await (
        await send(app.app, "GET", channelsPath(), { cookie: h.cookie })
      ).json()) as {
        items: Channel[];
      };
      expect(list.items.find((item) => item.id === channel.id)).toMatchObject({
        dryRun: true,
        liveBlocker: reason,
      });
    }
  });

  it("switches an active, connected channel live only when the server publishes live", async () => {
    const channel = await insertChannel(h.db, keyring, {
      workspaceId,
      platform: "instagram",
      connected: true,
    });
    const response = await patch(channel.id, { dryRun: false }, live.t);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dryRun: false, liveBlocker: null });
    const audit = (await audits(channel.id)).find((row) => row.action === "channel.updated");
    expect(audit?.data).toEqual({ changes: { dryRun: { from: true, to: false } } });

    // Back to dry-run is always allowed, even on a dry-run server.
    const back = await patch(channel.id, { dryRun: true });
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ dryRun: true, liveBlocker: "publishing_dry_run" });
  });

  it("lists and adds channels per workspace", async () => {
    const other = await insertWorkspace(h);
    const mine = ChannelSchema.parse(
      await (await createChannel({ platform: "instagram", displayName: "Mine" })).json(),
    );
    const response = await createChannel({ platform: "threads", displayName: "Theirs" }, other);
    expect(response.status).toBe(201);
    const theirs = ChannelSchema.parse(await response.json());
    expect(mine.workspaceId).toBe(workspaceId);
    expect(theirs.workspaceId).toBe(other);
    const seeded = await insertChannel(h.db, keyring, { workspaceId: other, platform: "facebook" });

    const ids = (await listed()).map((channel) => channel.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(ids).not.toContain(seeded.id);
    const otherItems = await listed(other);
    expect(otherItems.map((channel) => channel.id).sort()).toEqual([theirs.id, seeded.id].sort());
    expect(otherItems.every((channel) => channel.workspaceId === other)).toBe(true);

    const created = (await audits(theirs.id)).find((row) => row.action === "channel.created");
    expect(created?.data).toMatchObject({ workspaceId: other, platform: "threads" });
  });

  it("refuses channels in an archived or unknown workspace", async () => {
    const archived = await insertWorkspace(h, "archived");
    const refused = await createChannel({ platform: "instagram", displayName: "Late" }, archived);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { details: { reason: "archived" } } });
    // An archived workspace still lists the channels it had.
    expect(await listed(archived)).toEqual([]);

    const missing = randomUUID();
    const unknownList = await call(h, "GET", channelsPath(missing));
    expect(unknownList.status).toBe(404);
    expect(await errorCode(unknownList)).toBe("not_found");
    const unknownCreate = await createChannel({ platform: "instagram", displayName: "A" }, missing);
    expect(unknownCreate.status).toBe(404);
  });

  it("needs a session", async () => {
    expect((await h.t.app.request(channelsPath())).status).toBe(401);
    const refused = await send(h.t.app, "POST", channelsPath(), {
      body: { platform: "instagram", displayName: "A" },
    });
    expect(refused.status).toBe(401);
  });
});

describe("series channels", () => {
  async function put(seriesId: string, body: unknown): Promise<Response> {
    return call(h, "PUT", `/api/series/${seriesId}/channels`, body);
  }

  it("replaces a series' links and audits them", async () => {
    const seriesId = await newSeries();
    const a = await insertChannel(h.db, keyring, { workspaceId, platform: "instagram" });
    const b = await insertChannel(h.db, keyring, { workspaceId, platform: "threads" });
    const c = await insertChannel(h.db, keyring, { workspaceId, platform: "facebook" });

    const empty = await call(h, "GET", `/api/series/${seriesId}/channels`);
    expect(await empty.json()).toEqual({ seriesId, channels: [] });

    const first = await put(seriesId, {
      channels: [
        { channelId: a.id, enabled: true },
        { channelId: b.id, enabled: false },
      ],
    });
    expect(first.status).toBe(200);
    const links = SeriesChannelsSchema.parse(await first.json());
    expect(new Set(links.channels.map((link) => `${link.channelId}:${link.enabled}`))).toEqual(
      new Set([`${a.id}:true`, `${b.id}:false`]),
    );

    const second = await put(seriesId, {
      channels: [
        { channelId: b.id, enabled: true },
        { channelId: c.id, enabled: true },
      ],
    });
    const after = (await second.json()) as SeriesChannels;
    expect(new Set(after.channels.map((link) => `${link.channelId}:${link.enabled}`))).toEqual(
      new Set([`${b.id}:true`, `${c.id}:true`]),
    );
    const got = (await (
      await call(h, "GET", `/api/series/${seriesId}/channels`)
    ).json()) as SeriesChannels;
    expect(got.channels).toHaveLength(2);

    const rows = (await audits(seriesId)).filter((row) => row.action === "series.channels.updated");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.data).toMatchObject({ workspaceId });

    const cleared = await put(seriesId, { channels: [] });
    expect(await cleared.json()).toEqual({ seriesId, channels: [] });
  });

  it("refuses unknown channels, disabled channels and archived series", async () => {
    const seriesId = await newSeries();
    const unknown = await put(seriesId, { channels: [{ channelId: randomUUID(), enabled: true }] });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({
      error: { code: "validation_failed", details: [{ path: "channels.0.channelId" }] },
    });

    const disabled = await insertChannel(h.db, keyring, {
      workspaceId,
      status: "disabled",
      connected: true,
    });
    const refused = await put(seriesId, { channels: [{ channelId: disabled.id, enabled: true }] });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { details: { reason: "channel_disabled", channelId: disabled.id } },
    });
    // A disabled channel may stay linked as disabled.
    expect(
      (await put(seriesId, { channels: [{ channelId: disabled.id, enabled: false }] })).status,
    ).toBe(200);

    const repeated = await put(seriesId, {
      channels: [
        { channelId: disabled.id, enabled: false },
        { channelId: disabled.id, enabled: false },
      ],
    });
    expect(repeated.status).toBe(400);

    await h.db.update(series).set({ status: "archived" }).where(eq(series.id, seriesId));
    const archived = await put(seriesId, { channels: [] });
    expect(archived.status).toBe(409);
    expect(await archived.json()).toMatchObject({
      error: { details: { reason: "archived_series" } },
    });
  });

  it("refuses a channel of another workspace", async () => {
    const seriesId = await newSeries();
    const other = await insertWorkspace(h);
    const foreign = await insertChannel(h.db, keyring, { workspaceId: other, platform: "threads" });
    const own = await insertChannel(h.db, keyring, { workspaceId, platform: "instagram" });
    const refused = await put(seriesId, {
      channels: [
        { channelId: own.id, enabled: true },
        { channelId: foreign.id, enabled: true },
      ],
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "validation_failed",
        details: [
          { path: "channels.1.channelId", message: "No channel of this workspace has that id" },
        ],
      },
    });
    // Nothing was linked.
    const got = (await (
      await call(h, "GET", `/api/series/${seriesId}/channels`)
    ).json()) as SeriesChannels;
    expect(got.channels).toEqual([]);
  });

  it("404s unknown series", async () => {
    const missing = randomUUID();
    expect((await call(h, "GET", `/api/series/${missing}/channels`)).status).toBe(404);
    expect((await put(missing, { channels: [] })).status).toBe(404);
  });

  it("asks the cadence planner to replan the series", async () => {
    // The cadence module registers the planner, so a change queues a replan of the series.
    expect(h.deps.scheduler.hasHandler("cadence.plan")).toBe(true);
    const seriesId = await newSeries();
    await put(seriesId, { channels: [] });
    const plans = await h.db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.dedupeKey, `plan:${seriesId}`));
    expect(plans).toEqual([
      expect.objectContaining({
        kind: "cadence.plan",
        status: "pending",
        payload: { seriesId },
      }),
    ]);
  });
});
