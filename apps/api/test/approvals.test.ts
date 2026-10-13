import type { ApprovalsInbox, FormatRules } from "@loomcast/contracts";
import { contentItems, reviews } from "@loomcast/db";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transaction } from "../src/lib/db";
import { cadenceServiceFor } from "../src/modules/cadence";
import { contentServiceFor, SYSTEM_ACTOR } from "../src/modules/content";
import {
  type CalendarHarness,
  createCalendarHarness,
  createSeries,
  insertChannel,
  insertPost,
  linkChannel,
  pendingTask,
  postsOf,
  rulesWith,
} from "./calendar-support";
import {
  call,
  eventsOf,
  insertAsset,
  insertItem,
  insertProject,
  internalOf,
  script,
  storyboard,
  userOf,
} from "./pipeline-support";

let h: CalendarHarness;

beforeEach(async () => {
  h = await createCalendarHarness();
});

afterEach(async () => {
  await h.close();
});

/** A series on two channels, planned; `requiresApproval` applies to the second channel. */
async function plannedSeries(
  publishMode: FormatRules["publishMode"],
  secondRequiresApproval = false,
) {
  const projectId = await insertProject(h);
  const setup = await createSeries(
    h,
    projectId,
    rulesWith(
      { days: ["mon", "wed", "fri"], slots: ["09:00"], tz: "UTC", leadTimeHours: 1 },
      { publishMode },
    ),
  );
  const first = await insertChannel(h, { platform: "instagram" });
  const second = await insertChannel(h, {
    platform: "facebook",
    requiresApproval: secondRequiresApproval,
  });
  await linkChannel(h, setup.seriesId, first);
  await linkChannel(h, setup.seriesId, second);
  await cadenceServiceFor(h.deps).plan(setup.seriesId);
  const [item] = await h.db
    .select()
    .from(contentItems)
    .where(eq(contentItems.seriesId, setup.seriesId))
    .orderBy(asc(contentItems.targetAt));
  if (item === undefined) throw new Error("nothing was planned");
  return { projectId, ...setup, first, second, item };
}

/** Production finishing: a rendered version that goes straight to review. */
async function renderToReview(projectId: string, itemId: string): Promise<string> {
  const voiceAssetId = await insertAsset(h.db, {
    projectId,
    itemId,
    kind: "voice",
    durationMs: 31_000,
  });
  const renderAssetId = await insertAsset(h.db, {
    projectId,
    itemId,
    kind: "render",
    durationMs: 31_000,
  });
  const posterAssetId = await insertAsset(h.db, { projectId, itemId, kind: "poster" });
  const result = await transaction(h.db, (tx) =>
    contentServiceFor(h.deps).createVersion(
      tx,
      itemId,
      { script: script(), storyboard: storyboard(), voiceAssetId, renderAssetId, posterAssetId },
      SYSTEM_ACTOR,
      { state: "review" },
    ),
  );
  await h.settle();
  return result.version.id;
}

async function stateOf(itemId: string) {
  const [row] = await h.db.select().from(contentItems).where(eq(contentItems.id, itemId));
  return row?.state;
}

describe("approval rules", () => {
  it("approves an item whose posts are all auto, and queues its posts with that version", async () => {
    const { projectId, item } = await plannedSeries("auto");
    const versionId = await renderToReview(projectId, item.id);

    const [review] = await h.db.select().from(reviews).where(eq(reviews.itemId, item.id));
    expect(review).toMatchObject({ decision: "approve", actorKind: "system", versionId });
    expect(await stateOf(item.id)).toBe("scheduled");
    const vias = internalOf(h.internal, "content.item.state_changed")
      .filter((event) => event.payload.itemId === item.id)
      .map((event) => `${event.payload.from}>${event.payload.to}:${event.payload.via}`);
    expect(vias).toEqual([
      "idea>review:submit",
      "review>approved:auto_approve",
      "approved>scheduled:schedule",
    ]);

    const posts = await postsOf(h, item.id);
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post).toMatchObject({ status: "queued", versionId });
      const task = await pendingTask(h, `publish:${post.id}`);
      expect(task?.runAt.getTime()).toBe(post.scheduledAt.getTime());
    }
    const queued = eventsOf(h.live, "post.updated").filter(
      (event) => event.payload.post.itemId === item.id && event.payload.post.status === "queued",
    );
    expect(queued).toHaveLength(2);
    expect(queued.every((event) => event.payload.post.item.state === "scheduled")).toBe(true);
  });

  it("publishes the approved version in dry-run at the slot", async () => {
    const { projectId, item } = await plannedSeries("auto");
    const versionId = await renderToReview(projectId, item.id);
    h.clock.set(item.targetAt ?? new Date());
    await h.deps.scheduler.tick();
    await h.deps.scheduler.idle();
    await h.settle();
    const posts = await postsOf(h, item.id);
    expect(posts.map((post) => post.status)).toEqual(["published", "published"]);
    for (const post of posts) {
      expect(post.versionId).toBe(versionId);
      expect(post.permalink).toMatch(/^dryrun:\/\//);
    }
    expect(await stateOf(item.id)).toBe("published");
  });

  it("waits for a person when any post needs approval, then queues on approval", async () => {
    const { projectId, item, second } = await plannedSeries("auto", true);
    const versionId = await renderToReview(projectId, item.id);
    expect(await stateOf(item.id)).toBe("review");
    expect((await postsOf(h, item.id)).every((post) => post.status === "planned")).toBe(true);

    const inbox = await call(h, "GET", `/api/approvals?projectId=${projectId}`);
    expect(inbox.status).toBe(200);
    const body = (await inbox.json()) as ApprovalsInbox;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.item.id).toBe(item.id);
    expect(body.items[0]?.deadlineAt).toBe(item.targetAt?.toISOString());
    expect(body.items[0]?.posts.map((post) => post.publishMode).sort()).toEqual([
      "approval",
      "auto",
    ]);
    expect(body.items[0]?.posts.find((post) => post.channelId === second)?.publishMode).toBe(
      "approval",
    );

    const approved = await call(h, "POST", `/api/content/${item.id}/reviews`, {
      versionId,
      decision: "approve",
    });
    expect(approved.status).toBe(201);
    await h.settle();
    expect(await stateOf(item.id)).toBe("scheduled");
    for (const post of await postsOf(h, item.id)) {
      expect(post).toMatchObject({ status: "queued", versionId });
    }
    const after = (await (await call(h, "GET", "/api/approvals")).json()) as ApprovalsInbox;
    expect(after.items.some((entry) => entry.item.id === item.id)).toBe(false);
  });

  it("keeps an approval-mode item in review", async () => {
    const { projectId, item } = await plannedSeries("approval");
    await renderToReview(projectId, item.id);
    expect(await stateOf(item.id)).toBe("review");
    const [review] = await h.db.select().from(reviews).where(eq(reviews.itemId, item.id));
    expect(review).toBeUndefined();
  });

  it("does not approve an item without planned posts, even in auto mode", async () => {
    const projectId = await insertProject(h);
    const { seriesId } = await createSeries(h, projectId, rulesWith({}, { publishMode: "auto" }));
    const created = await contentServiceFor(h.deps).create(
      projectId,
      { title: "Loose idea", seriesId },
      userOf(h),
    );
    await renderToReview(projectId, created.item.id);
    expect(await stateOf(created.item.id)).toBe("review");
  });

  it("takes queued posts back to planned when the item leaves approval", async () => {
    const projectId = await insertProject(h);
    const channel = await insertChannel(h);
    const item = await insertItem(h, { projectId, state: "approved", level: "render" });
    const post = await insertPost(h, {
      itemId: item.itemId,
      channelId: channel,
      scheduledAt: new Date("2026-10-14T09:00:00.000Z"),
      status: "queued",
      versionId: item.versionId,
    });
    await transaction(h.db, (tx) =>
      contentServiceFor(h.deps).transition(tx, item.itemId, "script", userOf(h), { via: "edit" }),
    );
    await h.settle();
    const [after] = await postsOf(h, item.itemId);
    expect(after).toMatchObject({ id: post.id, status: "planned", versionId: null });
    expect(after?.updatedAt.getTime()).toBeGreaterThan(post.updatedAt.getTime());
  });

  it("moves queued posts to a new approved version and schedules the item", async () => {
    const projectId = await insertProject(h);
    const channel = await insertChannel(h);
    const item = await insertItem(h, { projectId, state: "approved", level: "render" });
    await insertPost(h, {
      itemId: item.itemId,
      channelId: channel,
      scheduledAt: new Date("2026-10-14T09:00:00.000Z"),
      status: "queued",
      versionId: item.versionId,
    });
    const edited = await contentServiceFor(h.deps).edit(
      item.itemId,
      { baseVersionId: item.versionId, caption: "A sharper caption" },
      userOf(h),
    );
    await h.settle();
    expect(edited.version.id).not.toBe(item.versionId);
    const [post] = await postsOf(h, item.itemId);
    expect(post).toMatchObject({ status: "queued", versionId: edited.version.id });
    expect(await stateOf(item.itemId)).toBe("scheduled");
  });

  it("returns posts to planned when a person unschedules the item", async () => {
    const projectId = await insertProject(h);
    const channel = await insertChannel(h);
    const item = await insertItem(h, { projectId, state: "scheduled", level: "render" });
    await insertPost(h, {
      itemId: item.itemId,
      channelId: channel,
      scheduledAt: new Date("2026-10-14T09:00:00.000Z"),
      status: "queued",
      versionId: item.versionId,
    });
    await transaction(h.db, (tx) =>
      contentServiceFor(h.deps).transition(tx, item.itemId, "approved", userOf(h), {
        via: "unschedule",
      }),
    );
    await h.settle();
    expect(await stateOf(item.itemId)).toBe("approved");
    const [post] = await postsOf(h, item.itemId);
    expect(post).toMatchObject({ status: "planned", versionId: null });
  });

  it("cancels the open posts of an archived item", async () => {
    const { item } = await plannedSeries("approval");
    await contentServiceFor(h.deps).archive(item.id, userOf(h));
    await h.settle();
    expect((await postsOf(h, item.id)).map((post) => post.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });
});

describe("approvals inbox", () => {
  it("orders items by deadline and lists missed posts, most recent first", async () => {
    const projectId = await insertProject(h);
    const otherProject = await insertProject(h);
    const channel = await insertChannel(h);
    const late = await insertItem(h, { projectId, state: "review", level: "render" });
    const soon = await insertItem(h, { projectId, state: "review", level: "render" });
    const none = await insertItem(h, { projectId, state: "review", level: "render" });
    const elsewhere = await insertItem(h, {
      projectId: otherProject,
      state: "review",
      level: "render",
    });
    await insertPost(h, {
      itemId: late.itemId,
      channelId: channel,
      scheduledAt: new Date("2026-10-20T09:00:00.000Z"),
    });
    await insertPost(h, {
      itemId: soon.itemId,
      channelId: channel,
      scheduledAt: new Date("2026-10-13T09:00:00.000Z"),
    });
    const idea = await insertItem(h, { projectId, state: "idea" });
    const ideaTwo = await insertItem(h, { projectId, state: "idea" });
    const older = await insertPost(h, {
      itemId: idea.itemId,
      channelId: channel,
      scheduledAt: new Date("2026-10-05T09:00:00.000Z"),
      status: "missed",
    });
    const newer = await insertPost(h, {
      itemId: ideaTwo.itemId,
      channelId: channel,
      scheduledAt: new Date("2026-10-09T09:00:00.000Z"),
      status: "missed",
    });

    const response = await call(h, "GET", `/api/approvals?projectId=${projectId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const inbox = (await response.json()) as ApprovalsInbox;
    expect(inbox.items.map((entry) => entry.item.id)).toEqual([
      soon.itemId,
      late.itemId,
      none.itemId,
    ]);
    expect(inbox.items.map((entry) => entry.deadlineAt)).toEqual([
      "2026-10-13T09:00:00.000Z",
      "2026-10-20T09:00:00.000Z",
      null,
    ]);
    expect(inbox.missed.map((post) => post.id)).toEqual([newer.id, older.id]);

    const everything = (await (await call(h, "GET", "/api/approvals")).json()) as ApprovalsInbox;
    expect(everything.items.map((entry) => entry.item.id)).toContain(elsewhere.itemId);
    expect((await call(h, "GET", "/api/approvals?projectId=nope")).status).toBe(400);
  });
});
