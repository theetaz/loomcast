import { canTransition, type FormatRules } from "@loomcast/contracts";
import { contentItems, jobs, scheduledPosts, scheduledTasks } from "@loomcast/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cadenceServiceFor,
  pickTopic,
  planTaskKey,
  produceForSlot,
  produceTaskKey,
} from "../src/modules/cadence";
import { calendarServiceFor } from "../src/modules/calendar";
import { formatsServiceFor } from "../src/modules/formats";
import { seriesServiceFor } from "../src/modules/series";
import {
  type CalendarHarness,
  createCalendarHarness,
  createSeries,
  HOUR_MS,
  insertChannel,
  linkChannel,
  MONDAY,
  pendingTask,
  postsOf,
  rulesWith,
  tasksOfKind,
} from "./calendar-support";
import { eventsOf, insertWorkspace, userOf } from "./pipeline-support";

describe("pickTopic", () => {
  it("takes never-used topics first, in pool order", () => {
    expect(pickTopic({ pool: ["Ownership", "Lifetimes", "Traits"], avoid: [], history: [] })).toBe(
      "Ownership",
    );
    expect(
      pickTopic({
        pool: ["Ownership", "Lifetimes", "Traits"],
        avoid: [],
        history: [{ topic: "ownership", at: 1 }],
      }),
    ).toBe("Lifetimes");
  });

  it("takes the least recently used topic once every topic was used", () => {
    const history = [
      { topic: "Ownership", at: 30 },
      { topic: "Lifetimes", at: 10 },
      { topic: "Traits", at: 20 },
      { topic: "Macros", at: 40 },
    ];
    expect(
      pickTopic({
        pool: ["Ownership", "Lifetimes", "Traits", "Macros"],
        avoid: [],
        history,
        recent: 2,
      }),
    ).toBe("Lifetimes");
  });

  it("skips the last N topics while others remain, and relaxes when none do", () => {
    const history = [
      { topic: "Ownership", at: new Date("2026-10-01") },
      { topic: "Lifetimes", at: new Date("2026-10-02") },
    ];
    // Traits was never used.
    expect(
      pickTopic({ pool: ["Ownership", "Lifetimes", "Traits"], avoid: [], history, recent: 3 }),
    ).toBe("Traits");
    // Both topics are recent: the older one is picked anyway.
    expect(pickTopic({ pool: ["Ownership", "Lifetimes"], avoid: [], history, recent: 3 })).toBe(
      "Ownership",
    );
    // With a window of one, only the latest is skipped.
    expect(pickTopic({ pool: ["Lifetimes", "Ownership"], avoid: [], history, recent: 1 })).toBe(
      "Ownership",
    );
  });

  it("never picks a topic that contains an avoided word, ignoring case and spaces", () => {
    expect(
      pickTopic({
        pool: ["  Unsafe Rust tricks ", "Borrow checker", "borrow checker"],
        avoid: ["UNSAFE"],
        history: [],
      }),
    ).toBe("Borrow checker");
    expect(pickTopic({ pool: ["Unsafe code"], avoid: ["unsafe"], history: [] })).toBeNull();
    expect(pickTopic({ pool: [], avoid: [], history: [] })).toBeNull();
  });
});

describe("cadence planning", () => {
  let h: CalendarHarness;

  beforeEach(async () => {
    h = await createCalendarHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  /** A series publishing Mon/Wed/Fri at 09:00 UTC on two channels, produced an hour ahead. */
  async function weeklySeries(overrides: Partial<FormatRules> = {}) {
    const workspaceId = await insertWorkspace(h);
    const rules = rulesWith(
      { days: ["mon", "wed", "fri"], slots: ["09:00"], tz: "UTC", leadTimeHours: 1 },
      { topicPool: ["Ownership", "Lifetimes", "Traits", "Unsafe code"], avoid: ["unsafe"] },
    );
    const setup = await createSeries(h, workspaceId, { ...rules, ...overrides });
    const instagram = await insertChannel(h, workspaceId, { platform: "instagram" });
    const threads = await insertChannel(h, workspaceId, { platform: "threads" });
    await linkChannel(h, setup.seriesId, instagram);
    await linkChannel(h, setup.seriesId, threads);
    return { workspaceId, ...setup, instagram, threads };
  }

  async function itemsOf(seriesId: string) {
    return h.db
      .select()
      .from(contentItems)
      .where(eq(contentItems.seriesId, seriesId))
      .orderBy(asc(contentItems.targetAt), asc(contentItems.createdAt));
  }

  async function plannedPosts(seriesId: string) {
    return h.db
      .select()
      .from(scheduledPosts)
      .where(and(eq(scheduledPosts.seriesId, seriesId), eq(scheduledPosts.status, "planned")))
      .orderBy(asc(scheduledPosts.scheduledAt), asc(scheduledPosts.channelId));
  }

  /** Runs the scheduler once at the current fake time and waits for its handlers. */
  async function tick() {
    await h.settle();
    await h.deps.scheduler.tick();
    await h.deps.scheduler.idle();
    await h.settle();
  }

  it("plans an idea and a planned post per channel for each slot, and only once", async () => {
    const { seriesId, instagram, threads } = await weeklySeries();
    const [result] = await cadenceServiceFor(h.deps).plan(seriesId);

    // 14 days from Monday 00:00: Mon 12, Wed 14, Fri 16, Mon 19, Wed 21, Fri 23.
    const slots = ["12", "14", "16", "19", "21", "23"].map((day) => `2026-10-${day}T09:00:00.000Z`);
    expect(result?.slots).toBe(6);
    expect(result?.createdItems).toHaveLength(6);
    expect(result?.createdPosts).toHaveLength(12);

    const items = await itemsOf(seriesId);
    expect(items.map((item) => item.targetAt?.toISOString())).toEqual(slots);
    expect(items.map((item) => item.title)).toEqual(
      slots.map((slot) => `Rust in 60 · ${slot.slice(0, 10)}`),
    );
    expect(new Set(items.map((item) => item.state))).toEqual(new Set(["idea"]));
    expect(new Set(items.map((item) => item.createdVia))).toEqual(new Set(["system"]));
    // Least recently used first; "Unsafe code" is avoided; the window relaxes once all are used.
    expect(items.map((item) => item.topic)).toEqual([
      "Ownership",
      "Lifetimes",
      "Traits",
      "Ownership",
      "Lifetimes",
      "Traits",
    ]);

    const posts = await plannedPosts(seriesId);
    expect(posts).toHaveLength(12);
    for (const post of posts) {
      expect(post.versionId).toBeNull();
      // The server runs in dry-run mode, whatever the channel says.
      expect(post.dryRun).toBe(true);
      const item = items.find((entry) => entry.id === post.itemId);
      expect(post.scheduledAt.getTime()).toBe(item?.targetAt?.getTime());
    }
    expect(new Set(posts.map((post) => post.channelId))).toEqual(new Set([instagram, threads]));

    // Production starts an hour before each slot; each post publishes at its slot.
    const produce = await tasksOfKind(h, "cadence.produce");
    expect(produce).toHaveLength(6);
    for (const item of items) {
      const task = await pendingTask(h, produceTaskKey(item.id));
      expect(task?.runAt.getTime()).toBe((item.targetAt?.getTime() ?? 0) - HOUR_MS);
    }
    for (const post of posts) {
      const task = await pendingTask(h, `publish:${post.id}`);
      expect(task?.kind).toBe("post.publish");
      expect(task?.runAt.getTime()).toBe(post.scheduledAt.getTime());
    }
    expect(eventsOf(h.live, "post.updated")).toHaveLength(12);

    // Planning again, directly or through the scheduler, creates nothing.
    const [again] = await cadenceServiceFor(h.deps).plan(seriesId);
    expect(again).toMatchObject({ createdItems: [], createdPosts: [], retiredItems: [] });
    await h.deps.scheduler.enqueue("cadence.plan", {});
    await tick();
    expect(await itemsOf(seriesId)).toHaveLength(6);
    expect(await plannedPosts(seriesId)).toHaveLength(12);
    expect(await tasksOfKind(h, "cadence.produce")).toHaveLength(6);
    expect(await tasksOfKind(h, "post.publish")).toHaveLength(12);
  });

  it("produces right away when the lead time has already begun", async () => {
    const { seriesId } = await weeklySeries();
    h.clock.set(new Date("2026-10-12T08:30:00.000Z"));
    await cadenceServiceFor(h.deps).plan(seriesId);
    const [first] = await itemsOf(seriesId);
    expect(first?.targetAt?.toISOString()).toBe("2026-10-12T09:00:00.000Z");
    const task = await pendingTask(h, produceTaskKey(first?.id ?? ""));
    expect(task?.runAt.toISOString()).toBe("2026-10-12T08:30:00.000Z");
  });

  it("marks posts dry-run only when the channel or the server says so", async () => {
    await h.close();
    h = await createCalendarHarness({ config: { publishing: { mode: "live", enabled: true } } });
    const workspaceId = await insertWorkspace(h);
    const { seriesId } = await createSeries(
      h,
      workspaceId,
      rulesWith({ days: ["mon"], slots: ["09:00"], tz: "UTC", leadTimeHours: 1 }),
    );
    const live = await insertChannel(h, workspaceId, { dryRun: false });
    const dry = await insertChannel(h, workspaceId, { dryRun: true });
    await linkChannel(h, seriesId, live);
    await linkChannel(h, seriesId, dry);
    await cadenceServiceFor(h.deps).plan(seriesId);
    const posts = await plannedPosts(seriesId);
    expect(posts.filter((post) => post.channelId === live).every((post) => !post.dryRun)).toBe(
      true,
    );
    expect(posts.filter((post) => post.channelId === dry).every((post) => post.dryRun)).toBe(true);
  });

  it("follows the series' time zone across both daylight saving changes", async () => {
    const workspaceId = await insertWorkspace(h);
    const everyDay = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
    const newYork = (slot: string) =>
      rulesWith({ days: [...everyDay], slots: [slot], tz: "America/New_York", leadTimeHours: 1 });
    const fall = await createSeries(h, workspaceId, newYork("09:00"), "Fall back");
    const spring = await createSeries(h, workspaceId, newYork("02:30"), "Spring forward");
    const colombo = await createSeries(
      h,
      workspaceId,
      rulesWith({ days: ["mon"], slots: ["18:30"], tz: "Asia/Colombo", leadTimeHours: 2 }),
      "Colombo",
    );
    const channel = await insertChannel(h, workspaceId);
    for (const setup of [fall, spring, colombo]) await linkChannel(h, setup.seriesId, channel);

    // New York falls back on Sunday 1 November 2026: 09:00 is 13:00Z before, 14:00Z after.
    h.clock.set(new Date("2026-10-30T00:00:00.000Z"));
    await cadenceServiceFor(h.deps).plan(fall.seriesId);
    const fallItems = (await itemsOf(fall.seriesId)).slice(0, 5);
    expect(fallItems.map((item) => item.targetAt?.toISOString())).toEqual([
      "2026-10-30T13:00:00.000Z",
      "2026-10-31T13:00:00.000Z",
      "2026-11-01T14:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
      "2026-11-03T14:00:00.000Z",
    ]);
    expect(fallItems.map((item) => item.title)).toEqual([
      "Fall back · 2026-10-30",
      "Fall back · 2026-10-31",
      "Fall back · 2026-11-01",
      "Fall back · 2026-11-02",
      "Fall back · 2026-11-03",
    ]);

    // Colombo has no daylight saving: Monday 18:30 is always 13:00Z.
    await cadenceServiceFor(h.deps).plan(colombo.seriesId);
    expect((await itemsOf(colombo.seriesId)).map((item) => item.targetAt?.toISOString())).toEqual([
      "2026-11-02T13:00:00.000Z",
      "2026-11-09T13:00:00.000Z",
    ]);

    // New York springs forward on Sunday 14 March 2027: 02:30 does not exist that day and moves
    // to 03:00 EDT (07:00Z); the next day 02:30 EDT is 06:30Z.
    h.clock.set(new Date("2027-03-12T00:00:00.000Z"));
    await cadenceServiceFor(h.deps).plan(spring.seriesId);
    const springItems = (await itemsOf(spring.seriesId)).slice(0, 4);
    expect(springItems.map((item) => item.targetAt?.toISOString())).toEqual([
      "2027-03-12T07:30:00.000Z",
      "2027-03-13T07:30:00.000Z",
      "2027-03-14T07:00:00.000Z",
      "2027-03-15T06:30:00.000Z",
    ]);
    expect(springItems[2]?.title).toBe("Spring forward · 2027-03-14");
    // The production task of the moved slot starts an hour before the real instant.
    const moved = await pendingTask(h, produceTaskKey(springItems[2]?.id ?? ""));
    expect(moved?.runAt.toISOString()).toBe("2027-03-14T06:00:00.000Z");
  });

  it("gives up untouched ideas when the series is paused, and plans again on resume", async () => {
    const { seriesId } = await weeklySeries();
    await cadenceServiceFor(h.deps).plan(seriesId);
    const [first, second, ...rest] = await itemsOf(seriesId);
    if (first === undefined || second === undefined) throw new Error("items were not planned");
    // One idea is already in production: it keeps its posts.
    await h.db.update(contentItems).set({ state: "script" }).where(eq(contentItems.id, first.id));
    // An item a person made for a slot is not the planner's to give up.
    await h.db.update(contentItems).set({ createdVia: "ui" }).where(eq(contentItems.id, second.id));

    const actor = userOf(h);
    await seriesServiceFor(h.deps).setStatus(seriesId, "pause", actor);
    await h.settle();
    // The change queued a replan of the series right away.
    expect((await pendingTask(h, planTaskKey(seriesId)))?.kind).toBe("cadence.plan");
    await tick();

    const archives = canTransition("idea", "archived", "system");
    for (const item of rest) {
      const posts = await postsOf(h, item.id);
      expect(posts.map((post) => post.status)).toEqual(["cancelled", "cancelled"]);
      const [row] = await h.db.select().from(contentItems).where(eq(contentItems.id, item.id));
      if (archives) {
        expect(row?.state).toBe("archived");
      } else {
        // Detached from the calendar: still an idea, without a slot.
        expect(row?.state).toBe("idea");
        expect(row?.targetAt).toBeNull();
      }
    }
    for (const kept of [first, second]) {
      const posts = await postsOf(h, kept.id);
      expect(posts.map((post) => post.status)).toEqual(["planned", "planned"]);
    }
    const cancelledEvents = eventsOf(h.live, "post.updated").filter(
      (event) => event.payload.post.status === "cancelled",
    );
    expect(cancelledEvents).toHaveLength(rest.length * 2);
    // Production of a retired idea never starts.
    const outcome = await produceForSlot(h.deps, rest[0]?.id ?? "");
    expect(outcome.kind).toBe(archives ? "gone" : "no_slot");

    await seriesServiceFor(h.deps).setStatus(seriesId, "resume", actor);
    await tick();
    const live = (await itemsOf(seriesId)).filter(
      (item) => item.state !== "archived" && item.targetAt !== null,
    );
    // The two kept items still hold their slots; the other four slots get new ideas.
    expect(live).toHaveLength(6);
    expect(new Set(live.map((item) => item.targetAt?.toISOString())).size).toBe(6);
    expect(await plannedPosts(seriesId)).toHaveLength(12);
  });

  it("replans when the cadence changes, keeping ideas whose slot remains", async () => {
    const { seriesId, formatId } = await weeklySeries();
    await cadenceServiceFor(h.deps).plan(seriesId);
    const before = await itemsOf(seriesId);
    const formats = formatsServiceFor(h.deps);
    const format = await formats.get(formatId);
    if (format === null) throw new Error("format is missing");
    const rules = structuredClone(format.currentVersion.rules);
    rules.cadence.days = ["mon", "tue"];
    await formats.update(formatId, { baseVersionId: format.currentVersion.id, rules }, userOf(h));
    await tick();

    const after = (await itemsOf(seriesId)).filter(
      (item) => item.state !== "archived" && item.targetAt !== null,
    );
    expect(after.map((item) => item.targetAt?.toISOString())).toEqual([
      "2026-10-12T09:00:00.000Z",
      "2026-10-13T09:00:00.000Z",
      "2026-10-19T09:00:00.000Z",
      "2026-10-20T09:00:00.000Z",
    ]);
    // Monday ideas survived the change; Wednesday and Friday ones were given up.
    const mondays = before.filter((item) => item.targetAt?.getUTCDay() === 1);
    expect(after.filter((item) => mondays.some((monday) => monday.id === item.id))).toHaveLength(2);
    const gone = before.filter((item) => item.targetAt?.getUTCDay() !== 1);
    for (const item of gone) {
      expect((await postsOf(h, item.id)).every((post) => post.status === "cancelled")).toBe(true);
    }
  });

  it("moves pending production when the lead time changes", async () => {
    const { seriesId, formatId } = await weeklySeries();
    await cadenceServiceFor(h.deps).plan(seriesId);
    const formats = formatsServiceFor(h.deps);
    const format = await formats.get(formatId);
    if (format === null) throw new Error("format is missing");
    const rules = structuredClone(format.currentVersion.rules);
    rules.cadence.leadTimeHours = 30;
    await formats.update(formatId, { baseVersionId: format.currentVersion.id, rules }, userOf(h));
    await h.settle();
    await cadenceServiceFor(h.deps).plan(seriesId);
    for (const item of await itemsOf(seriesId)) {
      const task = await pendingTask(h, produceTaskKey(item.id));
      const slot = item.targetAt?.getTime() ?? 0;
      expect(task?.runAt.getTime()).toBe(Math.max(MONDAY.getTime(), slot - 30 * HOUR_MS));
    }
    expect(await tasksOfKind(h, "cadence.produce")).toHaveLength(6);
  });

  it("unplans posts on a channel switched off, plans them again when it is back", async () => {
    const { seriesId, instagram, threads } = await weeklySeries();
    await cadenceServiceFor(h.deps).plan(seriesId);
    const [first] = await itemsOf(seriesId);
    if (first === undefined) throw new Error("items were not planned");
    // A person withdraws the Instagram post of the first idea.
    const instagramPost = (await postsOf(h, first.id)).find((post) => post.channelId === instagram);
    await calendarServiceFor(h.deps).cancel(instagramPost?.id ?? "", userOf(h));

    await linkChannel(h, seriesId, threads, false);
    const [off] = await cadenceServiceFor(h.deps).plan(seriesId);
    expect(off?.removedPosts).toHaveLength(6);
    expect((await plannedPosts(seriesId)).every((post) => post.channelId === instagram)).toBe(true);

    await linkChannel(h, seriesId, threads, true);
    const [on] = await cadenceServiceFor(h.deps).plan(seriesId);
    expect(on?.createdPosts).toHaveLength(6);
    expect(on?.createdItems).toHaveLength(0);
    // The withdrawn post stays withdrawn.
    const firstPosts = await postsOf(h, first.id);
    expect(firstPosts.find((post) => post.channelId === instagram)?.status).toBe("cancelled");
    expect(await plannedPosts(seriesId)).toHaveLength(11);
  });

  it("plans every active series on the hourly run", async () => {
    const one = await weeklySeries();
    // The second series shares the first one's workspace, so it may publish on its channel.
    const workspaceId = one.workspaceId;
    const two = await createSeries(
      h,
      workspaceId,
      rulesWith({ days: ["tue"], slots: ["10:00"], tz: "Europe/London", leadTimeHours: 1 }),
      "Second",
    );
    await linkChannel(h, two.seriesId, one.instagram);
    // A series without channels has no slots to fill.
    const bare = await createSeries(h, workspaceId, rulesWith({ days: ["mon"] }), "Bare");
    const results = await cadenceServiceFor(h.deps).plan();
    const byId = new Map(results.map((result) => [result.seriesId, result]));
    expect(byId.get(one.seriesId)?.createdItems).toHaveLength(6);
    // Tuesdays 13 and 20 October, 10:00 in London (BST) is 09:00Z.
    expect((await itemsOf(two.seriesId)).map((item) => item.targetAt?.toISOString())).toEqual([
      "2026-10-13T09:00:00.000Z",
      "2026-10-20T09:00:00.000Z",
    ]);
    expect(byId.get(bare.seriesId)?.createdItems ?? []).toHaveLength(0);
  });

  it("starts production up to review ahead of the slot", async () => {
    const { seriesId } = await weeklySeries();
    await cadenceServiceFor(h.deps).plan(seriesId);
    const [first, second] = await itemsOf(seriesId);
    if (first === undefined || second === undefined) throw new Error("items were not planned");
    // A person withdrew every post of the second idea: it has no slot left to produce for.
    for (const post of await postsOf(h, second.id)) {
      await calendarServiceFor(h.deps).cancel(post.id, userOf(h));
    }

    h.clock.set(new Date((first.targetAt?.getTime() ?? 0) - HOUR_MS));
    await tick();
    const [job] = await h.db
      .select()
      .from(jobs)
      .where(sql`${jobs.payload}->>'itemId' = ${first.id}`);
    expect(job?.type).toBe("content.write_script");
    const [item] = await h.db.select().from(contentItems).where(eq(contentItems.id, first.id));
    expect(item?.autopilotTarget).toBe("review");
    const [task] = await h.db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.dedupeKey, produceTaskKey(first.id)));
    expect(task?.status).toBe("succeeded");

    h.clock.set(new Date((second.targetAt?.getTime() ?? 0) - HOUR_MS));
    await tick();
    const skipped = await h.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(sql`${jobs.payload}->>'itemId' = ${second.id}`);
    expect(skipped).toHaveLength(0);
    const [secondTask] = await h.db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.dedupeKey, produceTaskKey(second.id)));
    expect(secondTask?.status).toBe("succeeded");
  });
});
