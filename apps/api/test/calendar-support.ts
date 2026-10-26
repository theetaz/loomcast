import { randomUUID } from "node:crypto";
import {
  type Cadence,
  DEFAULT_FORMAT_RULES,
  type FormatRules,
  type LiveEvent,
  type Platform,
  type PostStatus,
} from "@loomcast/contracts";
import {
  channels,
  type ScheduledPostRow,
  type ScheduledTaskRow,
  scheduledPosts,
  scheduledTasks,
  series,
  seriesChannels,
} from "@loomcast/db";
import { createTestDb } from "@loomcast/db/testing";
import { and, asc, eq } from "drizzle-orm";
import type { Config } from "../src/env";
import type { BusEventOf, InternalEvent } from "../src/lib/bus";
import { approvalsFor } from "../src/modules/approvals";
import { cadenceServiceFor } from "../src/modules/cadence";
import { formatsServiceFor } from "../src/modules/formats";
import { seriesServiceFor } from "../src/modules/series";
import type { PipelineHarness } from "./pipeline-support";
import { createTestApp, createTestClock, insertUser, login, type TestClock } from "./support";

/** Monday 12 October 2026, midnight UTC: the start of every calendar test unless one says so. */
export const MONDAY = new Date("2026-10-12T00:00:00.000Z");

export interface CalendarHarness extends PipelineHarness {
  clock: TestClock;
  /** Waits for bus-driven replans and approval rules to settle. */
  settle(): Promise<void>;
}

/** A test app on a fake clock, with a signed-in user and every published event recorded. */
export async function createCalendarHarness(
  options: { now?: Date; config?: Partial<Config> } = {},
): Promise<CalendarHarness> {
  const testDb = await createTestDb();
  const clock = createTestClock(options.now ?? MONDAY);
  let captured: PipelineHarness["deps"] | undefined;
  const t = createTestApp(testDb.db, {
    clock,
    ...(options.config === undefined ? {} : { config: options.config }),
    modules: [
      (app, moduleDeps) => {
        captured = moduleDeps;
        return app;
      },
    ],
  });
  if (captured === undefined) {
    throw new Error("module deps were not captured");
  }
  const deps = captured;
  const live: LiveEvent[] = [];
  const internal: InternalEvent[] = [];
  t.bus.subscribeLive((event) => {
    live.push(event);
  });
  for (const type of ["content.item.state_changed", "format.updated", "series.updated"] as const) {
    t.bus.subscribe(type, (event: BusEventOf<typeof type>) => {
      internal.push(event);
    });
  }
  const user = await insertUser(testDb.db);
  const { cookie } = await login(t.app, user.email);
  return {
    testDb,
    db: testDb.db,
    t,
    deps,
    cookie,
    userId: user.id,
    live,
    internal,
    clock,
    async settle() {
      // Rules may start more rule runs (auto-approval publishes further state changes).
      for (let round = 0; round < 5; round += 1) {
        await cadenceServiceFor(deps).idle();
        await approvalsFor(deps).work.idle();
      }
    },
    async close() {
      await t.deps.lifecycle.close();
      await testDb.drop();
    },
  };
}

export interface SeriesSetup {
  formatId: string;
  seriesId: string;
  formatVersionId: string;
}

/** Format rules with a cadence; the rest is the defaults. */
export function rulesWith(
  cadence: Partial<Cadence>,
  overrides: Partial<FormatRules> = {},
): FormatRules {
  const base = structuredClone(DEFAULT_FORMAT_RULES);
  return { ...base, ...overrides, cadence: { ...base.cadence, ...cadence } };
}

/** A format with `rules` and a series on it, created through the services as a user would. */
export async function createSeries(
  h: CalendarHarness,
  workspaceId: string,
  rules: FormatRules,
  name = "Rust in 60",
): Promise<SeriesSetup> {
  const actor = { kind: "user" as const, id: h.userId, userId: h.userId };
  const format = await formatsServiceFor(h.deps).create(
    workspaceId,
    { name: `${name} format`, rules },
    actor,
  );
  const series = await seriesServiceFor(h.deps).create(
    workspaceId,
    { name, formatId: format.id },
    actor,
  );
  return { formatId: format.id, seriesId: series.id, formatVersionId: format.currentVersion.id };
}

export interface ChannelSpec {
  platform?: Platform;
  dryRun?: boolean;
  requiresApproval?: boolean;
  status?: "disconnected" | "disabled";
}

/** A planning channel (no credentials) of `workspaceId`, dry-run unless `dryRun` is false. */
export async function insertChannel(
  h: CalendarHarness,
  workspaceId: string,
  spec: ChannelSpec = {},
): Promise<string> {
  const [row] = await h.db
    .insert(channels)
    .values({
      workspaceId,
      platform: spec.platform ?? "instagram",
      displayName: `Channel ${randomUUID().slice(0, 6)}`,
      status: spec.status ?? "disconnected",
      dryRun: spec.dryRun ?? true,
      requiresApproval: spec.requiresApproval ?? false,
      disabledAt: spec.status === "disabled" ? new Date() : null,
    })
    .returning({ id: channels.id });
  if (row === undefined) {
    throw new Error("channel was not inserted");
  }
  return row.id;
}

export async function linkChannel(
  h: CalendarHarness,
  seriesId: string,
  channelId: string,
  enabled = true,
): Promise<void> {
  const [owner] = await h.db
    .select({ workspaceId: series.workspaceId })
    .from(series)
    .where(eq(series.id, seriesId));
  if (owner === undefined) {
    throw new Error(`no series ${seriesId}`);
  }
  await h.db
    .insert(seriesChannels)
    .values({ workspaceId: owner.workspaceId, seriesId, channelId, enabled })
    .onConflictDoUpdate({
      target: [seriesChannels.seriesId, seriesChannels.channelId],
      set: { enabled },
    });
}

/** Inserts a post directly, for items the tests put in a state by hand. */
export async function insertPost(
  h: CalendarHarness,
  values: {
    itemId: string;
    channelId: string;
    scheduledAt: Date;
    status?: PostStatus;
    versionId?: string | null;
    seriesId?: string | null;
  },
): Promise<ScheduledPostRow> {
  const [row] = await h.db
    .insert(scheduledPosts)
    .values({
      itemId: values.itemId,
      channelId: values.channelId,
      seriesId: values.seriesId ?? null,
      scheduledAt: values.scheduledAt,
      status: values.status ?? "planned",
      versionId: values.versionId ?? null,
      publishedAt: values.status === "published" ? values.scheduledAt : null,
    })
    .returning();
  if (row === undefined) {
    throw new Error("post was not inserted");
  }
  return row;
}

export async function postsOf(h: CalendarHarness, itemId: string): Promise<ScheduledPostRow[]> {
  return h.db
    .select()
    .from(scheduledPosts)
    .where(eq(scheduledPosts.itemId, itemId))
    .orderBy(asc(scheduledPosts.scheduledAt), asc(scheduledPosts.channelId));
}

export async function postById(h: CalendarHarness, id: string): Promise<ScheduledPostRow> {
  const [row] = await h.db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id));
  if (row === undefined) {
    throw new Error(`no post ${id}`);
  }
  return row;
}

/** The pending task with this dedupe key, if any. */
export async function pendingTask(
  h: CalendarHarness,
  dedupeKey: string,
): Promise<ScheduledTaskRow | undefined> {
  const [row] = await h.db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.dedupeKey, dedupeKey), eq(scheduledTasks.status, "pending")));
  return row;
}

export async function tasksOfKind(h: CalendarHarness, kind: string): Promise<ScheduledTaskRow[]> {
  return h.db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.kind, kind))
    .orderBy(asc(scheduledTasks.runAt), asc(scheduledTasks.id));
}

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
