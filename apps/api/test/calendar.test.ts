import type { CalendarResponse, ScheduledPost } from "@loomcast/contracts";
import { contentItems } from "@loomcast/db";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cadenceServiceFor, produceTaskKey } from "../src/modules/cadence";
import {
  type CalendarHarness,
  createCalendarHarness,
  createSeries,
  DAY_MS,
  HOUR_MS,
  insertChannel,
  insertPost,
  linkChannel,
  MONDAY,
  pendingTask,
  postById,
  postsOf,
  rulesWith,
} from "./calendar-support";
import { call, eventsOf, insertItem, insertWorkspace } from "./pipeline-support";
import { errorCode } from "./support";

let h: CalendarHarness;

beforeEach(async () => {
  h = await createCalendarHarness();
});

afterEach(async () => {
  await h.close();
});

const WEEK = {
  from: MONDAY.toISOString(),
  to: new Date(MONDAY.getTime() + 7 * DAY_MS).toISOString(),
};

function calendarPath(query: Record<string, string>): string {
  return `/api/calendar?${new URLSearchParams(query).toString()}`;
}

async function getCalendar(query: Record<string, string>): Promise<CalendarResponse> {
  const response = await call(h, "GET", calendarPath(query));
  expect(response.status).toBe(200);
  return (await response.json()) as CalendarResponse;
}

async function stateOf(itemId: string) {
  const [row] = await h.db.select().from(contentItems).where(eq(contentItems.id, itemId));
  return row?.state;
}

/** An approved, rendered item and a channel to schedule it on. */
async function approvedItem(state: "approved" | "scheduled" | "review" | "idea" = "approved") {
  const workspaceId = await insertWorkspace(h);
  const channel = await insertChannel(h, workspaceId);
  const item = await insertItem(h, {
    workspaceId,
    state,
    level: state === "idea" ? "none" : "render",
  });
  return { workspaceId, channel, ...item };
}

describe("GET /api/calendar", () => {
  it("lists posts and cadence slots, held or open, from now on", async () => {
    const workspaceId = await insertWorkspace(h);
    const { seriesId } = await createSeries(
      h,
      workspaceId,
      rulesWith({ days: ["mon", "wed", "fri"], slots: ["09:00"], tz: "UTC", leadTimeHours: 1 }),
    );
    const one = await insertChannel(h, workspaceId);
    const two = await insertChannel(h, workspaceId, { platform: "threads" });
    await linkChannel(h, seriesId, one);
    await linkChannel(h, seriesId, two);
    await cadenceServiceFor(h.deps).plan(seriesId);

    // Wednesday noon: Monday's slot is history, Wednesday 09:00 too; Friday is still ahead.
    h.clock.set(new Date("2026-10-14T12:00:00.000Z"));
    const week = await getCalendar(WEEK);
    expect(week.posts).toHaveLength(6);
    expect(week.posts.map((post) => post.scheduledAt)).toEqual(
      [...week.posts.map((post) => post.scheduledAt)].sort(),
    );
    expect(week.posts[0]).toMatchObject({
      workspaceId,
      seriesId,
      status: "planned",
      publishMode: "approval",
      dryRun: true,
      item: { state: "idea" },
    });
    expect(week.slots.map((slot) => slot.at)).toEqual([
      "2026-10-16T09:00:00.000Z",
      "2026-10-16T09:00:00.000Z",
    ]);
    expect(week.slots.every((slot) => slot.postId !== undefined)).toBe(true);

    // A cancelled post stays in the list but frees its slot.
    const friday = week.posts.find(
      (post) => post.scheduledAt === "2026-10-16T09:00:00.000Z" && post.channelId === one,
    );
    const cancelled = await call(h, "POST", `/api/scheduled-posts/${friday?.id}/cancel`);
    expect(cancelled.status).toBe(200);
    const after = await getCalendar(WEEK);
    expect(after.posts.find((post) => post.id === friday?.id)?.status).toBe("cancelled");
    const open = after.slots.find((slot) => slot.channelId === one);
    expect(open?.postId).toBeUndefined();

    // Filters take comma-separated ids.
    const onlyTwo = await getCalendar({ ...WEEK, channelIds: two });
    expect(onlyTwo.posts.every((post) => post.channelId === two)).toBe(true);
    expect(onlyTwo.slots.map((slot) => slot.channelId)).toEqual([two]);
    const bySeries = await getCalendar({ ...WEEK, seriesIds: `${seriesId},${one}` });
    expect(bySeries.posts).toHaveLength(6);
    const otherWorkspace = await getCalendar({ ...WEEK, workspaceId: await insertWorkspace(h) });
    expect(otherWorkspace).toEqual({ posts: [], slots: [] });
  });

  it("refuses ranges over 62 days and malformed filters", async () => {
    const tooLong = await call(
      h,
      "GET",
      calendarPath({
        from: MONDAY.toISOString(),
        to: new Date(MONDAY.getTime() + 63 * DAY_MS).toISOString(),
      }),
    );
    expect(tooLong.status).toBe(400);
    expect(await errorCode(tooLong)).toBe("validation_failed");
    const badIds = await call(h, "GET", calendarPath({ ...WEEK, channelIds: "a,b" }));
    expect(await errorCode(badIds)).toBe("validation_failed");
  });
});

describe("POST /api/scheduled-posts", () => {
  it("schedules an approved item as a queued post with its publish task", async () => {
    const { itemId, versionId, channel, workspaceId } = await approvedItem();
    const at = new Date(MONDAY.getTime() + 2 * DAY_MS).toISOString();
    const response = await call(h, "POST", "/api/scheduled-posts", {
      itemId,
      channelId: channel,
      scheduledAt: at,
    });
    expect(response.status).toBe(201);
    const post = (await response.json()) as ScheduledPost;
    expect(post).toMatchObject({
      itemId,
      versionId,
      channelId: channel,
      scheduledAt: at,
      status: "queued",
      dryRun: true,
      item: { state: "scheduled" },
    });
    expect(await stateOf(itemId)).toBe("scheduled");
    expect((await pendingTask(h, `publish:${post.id}`))?.runAt.toISOString()).toBe(at);
    expect(eventsOf(h.live, "post.updated").map((event) => event.payload.post.id)).toEqual([
      post.id,
    ]);

    // One open post per item and channel.
    const again = await call(h, "POST", "/api/scheduled-posts", {
      itemId,
      channelId: channel,
      scheduledAt: at,
    });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("conflict");
    // A scheduled item may go out on another channel too.
    const other = await insertChannel(h, workspaceId, { platform: "threads" });
    const second = await call(h, "POST", "/api/scheduled-posts", {
      itemId,
      channelId: other,
      scheduledAt: at,
    });
    expect(second.status).toBe(201);
  });

  it("refuses times too soon, unapproved items and unusable channels", async () => {
    const { itemId, channel, workspaceId } = await approvedItem();
    const soon = await call(h, "POST", "/api/scheduled-posts", {
      itemId,
      channelId: channel,
      scheduledAt: new Date(MONDAY.getTime() + 60_000).toISOString(),
    });
    expect(soon.status).toBe(400);
    expect(await errorCode(soon)).toBe("validation_failed");

    const at = new Date(MONDAY.getTime() + DAY_MS).toISOString();
    const review = await approvedItem("review");
    const unapproved = await call(h, "POST", "/api/scheduled-posts", {
      itemId: review.itemId,
      channelId: review.channel,
      scheduledAt: at,
    });
    expect(unapproved.status).toBe(409);
    expect(await errorCode(unapproved)).toBe("invalid_transition");

    const disabled = await insertChannel(h, workspaceId, { status: "disabled" });
    const off = await call(h, "POST", "/api/scheduled-posts", {
      itemId,
      channelId: disabled,
      scheduledAt: at,
    });
    expect(off.status).toBe(409);
    expect(await errorCode(off)).toBe("conflict");

    const missing = await call(h, "POST", "/api/scheduled-posts", {
      itemId,
      channelId: crypto.randomUUID(),
      scheduledAt: at,
    });
    expect(missing.status).toBe(404);
    expect(await stateOf(itemId)).toBe("approved");
  });

  it("refuses a channel of another workspace", async () => {
    const { itemId } = await approvedItem();
    const foreign = await insertChannel(h, await insertWorkspace(h));
    const refused = await call(h, "POST", "/api/scheduled-posts", {
      itemId,
      channelId: foreign,
      scheduledAt: new Date(MONDAY.getTime() + DAY_MS).toISOString(),
    });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({
      error: { code: "not_found", message: "No channel of this workspace has that id." },
    });
    expect(await postsOf(h, itemId)).toEqual([]);
    expect(await stateOf(itemId)).toBe("approved");
  });
});

describe("PATCH /api/scheduled-posts/:id", () => {
  async function queuedPost() {
    const { itemId, versionId, channel, workspaceId } = await approvedItem("scheduled");
    const post = await insertPost(h, {
      itemId,
      channelId: channel,
      scheduledAt: new Date(MONDAY.getTime() + DAY_MS),
      status: "queued",
      versionId,
    });
    await h.deps.scheduler.enqueue(
      "post.publish",
      { postId: post.id },
      { runAt: post.scheduledAt, dedupeKey: `publish:${post.id}` },
    );
    return { itemId, versionId, channel, workspaceId, post };
  }

  it("moves a post and its publish task", async () => {
    const { post } = await queuedPost();
    const to = new Date(MONDAY.getTime() + 3 * DAY_MS).toISOString();
    const response = await call(h, "PATCH", `/api/scheduled-posts/${post.id}`, {
      scheduledAt: to,
      expectedUpdatedAt: post.updatedAt.toISOString(),
    });
    expect(response.status).toBe(200);
    const moved = (await response.json()) as ScheduledPost;
    expect(moved).toMatchObject({ scheduledAt: to, status: "queued" });
    expect(Date.parse(moved.updatedAt)).toBeGreaterThan(post.updatedAt.getTime());
    expect((await pendingTask(h, `publish:${post.id}`))?.runAt.toISOString()).toBe(to);
    expect(eventsOf(h.live, "post.updated").at(-1)?.payload.post.scheduledAt).toBe(to);

    // The old `updatedAt` is stale now.
    const stale = await call(h, "PATCH", `/api/scheduled-posts/${post.id}`, {
      scheduledAt: new Date(MONDAY.getTime() + 4 * DAY_MS).toISOString(),
      expectedUpdatedAt: post.updatedAt.toISOString(),
    });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("conflict");
    expect((await postById(h, post.id)).scheduledAt.toISOString()).toBe(to);
  });

  it("refuses times too soon and posts that can no longer move", async () => {
    const { post, itemId, versionId, workspaceId } = await queuedPost();
    const soon = await call(h, "PATCH", `/api/scheduled-posts/${post.id}`, {
      scheduledAt: new Date(MONDAY.getTime() + 60_000).toISOString(),
      expectedUpdatedAt: post.updatedAt.toISOString(),
    });
    expect(soon.status).toBe(400);
    expect(await errorCode(soon)).toBe("validation_failed");

    await call(h, "POST", `/api/scheduled-posts/${post.id}/cancel`);
    const other = await insertChannel(h, workspaceId);
    const published = await insertPost(h, {
      itemId,
      channelId: other,
      scheduledAt: new Date(MONDAY.getTime() - DAY_MS),
      status: "published",
      versionId,
    });
    for (const id of [post.id, published.id]) {
      const row = await postById(h, id);
      const refused = await call(h, "PATCH", `/api/scheduled-posts/${id}`, {
        scheduledAt: new Date(MONDAY.getTime() + 2 * DAY_MS).toISOString(),
        expectedUpdatedAt: row.updatedAt.toISOString(),
      });
      expect(refused.status).toBe(409);
      expect(await errorCode(refused)).toBe("post_not_editable");
    }
    const unknown = await call(h, "PATCH", `/api/scheduled-posts/${crypto.randomUUID()}`, {
      scheduledAt: new Date(MONDAY.getTime() + 2 * DAY_MS).toISOString(),
      expectedUpdatedAt: MONDAY.toISOString(),
    });
    expect(unknown.status).toBe(404);
  });

  it("brings a missed post back: queued for an approved item, planned otherwise", async () => {
    const approved = await approvedItem("approved");
    const missed = await insertPost(h, {
      itemId: approved.itemId,
      channelId: approved.channel,
      scheduledAt: new Date(MONDAY.getTime() - HOUR_MS),
      status: "missed",
    });
    const to = new Date(MONDAY.getTime() + DAY_MS).toISOString();
    const back = await call(h, "PATCH", `/api/scheduled-posts/${missed.id}`, {
      scheduledAt: to,
      expectedUpdatedAt: missed.updatedAt.toISOString(),
    });
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ status: "queued", versionId: approved.versionId });
    expect(await stateOf(approved.itemId)).toBe("scheduled");

    const idea = await approvedItem("idea");
    const ideaMissed = await insertPost(h, {
      itemId: idea.itemId,
      channelId: idea.channel,
      scheduledAt: new Date(MONDAY.getTime() - HOUR_MS),
      status: "missed",
    });
    const planned = await call(h, "PATCH", `/api/scheduled-posts/${ideaMissed.id}`, {
      scheduledAt: to,
      expectedUpdatedAt: ideaMissed.updatedAt.toISOString(),
    });
    expect(await planned.json()).toMatchObject({ status: "planned", versionId: null });
  });

  it("moves an idea's pending production with its post", async () => {
    const workspaceId = await insertWorkspace(h);
    const { seriesId } = await createSeries(
      h,
      workspaceId,
      rulesWith({ days: ["fri"], slots: ["09:00"], tz: "UTC", leadTimeHours: 2 }),
    );
    const channel = await insertChannel(h, workspaceId);
    await linkChannel(h, seriesId, channel);
    await cadenceServiceFor(h.deps).plan(seriesId);
    const [item] = await h.db
      .select()
      .from(contentItems)
      .where(eq(contentItems.seriesId, seriesId))
      .orderBy(asc(contentItems.targetAt));
    const [post] = await postsOf(h, item?.id ?? "");
    if (item === undefined || post === undefined) throw new Error("nothing was planned");
    const to = new Date("2026-10-14T18:00:00.000Z");
    const response = await call(h, "PATCH", `/api/scheduled-posts/${post.id}`, {
      scheduledAt: to.toISOString(),
      expectedUpdatedAt: post.updatedAt.toISOString(),
    });
    expect(response.status).toBe(200);
    const task = await pendingTask(h, produceTaskKey(item.id));
    expect(task?.runAt.toISOString()).toBe("2026-10-14T16:00:00.000Z");
  });
});

describe("POST /api/scheduled-posts/:id/cancel", () => {
  it("cancels a post and unschedules an item left without queued posts", async () => {
    const { itemId, versionId, channel, workspaceId } = await approvedItem("scheduled");
    const other = await insertChannel(h, workspaceId);
    const first = await insertPost(h, {
      itemId,
      channelId: channel,
      scheduledAt: new Date(MONDAY.getTime() + DAY_MS),
      status: "queued",
      versionId,
    });
    const second = await insertPost(h, {
      itemId,
      channelId: other,
      scheduledAt: new Date(MONDAY.getTime() + DAY_MS),
      status: "queued",
      versionId,
    });
    const one = await call(h, "POST", `/api/scheduled-posts/${first.id}/cancel`);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ status: "cancelled", item: { state: "scheduled" } });
    expect(await stateOf(itemId)).toBe("scheduled");

    const two = await call(h, "POST", `/api/scheduled-posts/${second.id}/cancel`);
    expect(await two.json()).toMatchObject({ status: "cancelled", item: { state: "approved" } });
    await h.settle();
    expect(await stateOf(itemId)).toBe("approved");

    const again = await call(h, "POST", `/api/scheduled-posts/${second.id}/cancel`);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("post_not_editable");
    expect(
      (await call(h, "POST", `/api/scheduled-posts/${crypto.randomUUID()}/cancel`)).status,
    ).toBe(404);
  });
});
