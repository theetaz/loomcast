import { randomUUID } from "node:crypto";
import {
  type ContentItem,
  ContentItemSchema,
  CreateReviewResponseSchema,
  cursorPageSchema,
  listSchema,
  ReviewSchema,
} from "@loomcast/contracts";
import { contentItems, contentVersions, reviews } from "@loomcast/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transaction } from "../src/lib/db";
import { HttpError } from "../src/lib/errors";
import { SYSTEM_ACTOR } from "../src/modules/content";
import { reviewsServiceFor } from "../src/modules/reviews";
import {
  call,
  createPipelineHarness,
  eventsOf,
  insertItem,
  insertProject,
  internalOf,
  type PipelineHarness,
} from "./pipeline-support";
import { errorCode } from "./support";

const ItemPage = cursorPageSchema(ContentItemSchema);

let h: PipelineHarness;
let projectId: string;

beforeAll(async () => {
  h = await createPipelineHarness();
  projectId = await insertProject(h);
});

afterAll(async () => {
  await h.close();
});

function decide(itemId: string, body: Record<string, unknown>) {
  return call(h, "POST", `/api/content/${itemId}/reviews`, body);
}

async function decideOk(itemId: string, body: Record<string, unknown>) {
  const response = await decide(itemId, body);
  expect(response.status, await response.clone().text()).toBe(201);
  return CreateReviewResponseSchema.parse(await response.json());
}

describe("review decisions", () => {
  it("approves a rendered version in review", async () => {
    const inserted = await insertItem(h, { projectId, state: "review", level: "render" });
    const result = await decideOk(inserted.itemId, {
      versionId: inserted.versionId,
      decision: "approve",
    });
    expect(result.item.state).toBe("approved");
    expect(result.review).toMatchObject({
      itemId: inserted.itemId,
      versionId: inserted.versionId,
      decision: "approve",
      comment: null,
      enqueueRevision: false,
      userId: h.userId,
      actorKind: "user",
    });

    const [created] = eventsOf(h.live, "review.created").filter(
      (event) => event.payload.review.itemId === inserted.itemId,
    );
    expect(created?.payload).toEqual({ projectId, review: result.review });
    const [change] = internalOf(h.internal, "content.item.state_changed").filter(
      (event) => event.payload.itemId === inserted.itemId,
    );
    expect(change?.payload).toMatchObject({ from: "review", to: "approved", via: "approve" });

    const list = listSchema(ReviewSchema).parse(
      await (await call(h, "GET", `/api/content/${inserted.itemId}/reviews`)).json(),
    );
    expect(list.items.map((review) => review.id)).toEqual([result.review.id]);
  });

  it("needs a render to approve", async () => {
    const inserted = await insertItem(h, { projectId, state: "review", level: "voice" });
    const response = await decide(inserted.itemId, {
      versionId: inserted.versionId,
      decision: "approve",
    });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("missing_artifact");
  });

  it("needs the item in review and its current version", async () => {
    const rendered = await insertItem(h, { projectId, state: "render", level: "render" });
    const notInReview = await decide(rendered.itemId, {
      versionId: rendered.versionId,
      decision: "approve",
    });
    expect(notInReview.status).toBe(409);
    expect(await errorCode(notInReview)).toBe("invalid_transition");

    const inReview = await insertItem(h, { projectId, state: "review", level: "render" });
    const [first] = await h.db
      .select({ id: contentVersions.id })
      .from(contentVersions)
      .where(and(eq(contentVersions.itemId, inReview.itemId), eq(contentVersions.versionNo, 1)));
    const stale = await decide(inReview.itemId, { versionId: first?.id, decision: "approve" });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("conflict");

    const missing = await decide(randomUUID(), { versionId: randomUUID(), decision: "reject" });
    expect(missing.status).toBe(404);
  });

  it("requests changes with a comment and records whether to revise", async () => {
    const noComment = await insertItem(h, { projectId, state: "review", level: "render" });
    const refused = await decide(noComment.itemId, {
      versionId: noComment.versionId,
      decision: "request_changes",
    });
    expect(refused.status).toBe(400);

    const result = await decideOk(noComment.itemId, {
      versionId: noComment.versionId,
      decision: "request_changes",
      comment: "Make the hook punchier.",
    });
    expect(result.item.state).toBe("script");
    expect(result.review).toMatchObject({
      decision: "request_changes",
      comment: "Make the hook punchier.",
      enqueueRevision: true,
    });
    // The version stays: the producer revises on top of it.
    expect(result.item.currentVersionId).toBe(noComment.versionId);

    const manual = await insertItem(h, { projectId, state: "review", level: "render" });
    const kept = await decideOk(manual.itemId, {
      versionId: manual.versionId,
      decision: "request_changes",
      comment: "I will fix it myself.",
      enqueueRevision: false,
    });
    expect(kept.review.enqueueRevision).toBe(false);
    const [row] = await h.db.select().from(reviews).where(eq(reviews.id, kept.review.id));
    expect(row?.enqueueRevision).toBe(false);

    const onlyChanges = await decide(manual.itemId, {
      versionId: manual.versionId,
      decision: "approve",
      enqueueRevision: true,
    });
    expect(onlyChanges.status).toBe(400);
  });

  it("rejects into the archive", async () => {
    const inserted = await insertItem(h, { projectId, state: "review", level: "voice" });
    const result = await decideOk(inserted.itemId, {
      versionId: inserted.versionId,
      decision: "reject",
      comment: "Off topic.",
    });
    expect(result.item.state).toBe("archived");
    expect(result.item.archivedAt).not.toBeNull();
  });

  it("lets the system auto-approve and keeps tokens and devices out", async () => {
    const service = reviewsServiceFor(h.deps);
    const auto = await insertItem(h, { projectId, state: "review", level: "render" });
    const result = await service.create(
      auto.itemId,
      { versionId: auto.versionId, decision: "approve" },
      SYSTEM_ACTOR,
    );
    expect(result?.item.state).toBe("approved");
    expect(result?.review).toMatchObject({ actorKind: "system", userId: null });
    const [change] = internalOf(h.internal, "content.item.state_changed").filter(
      (event) => event.payload.itemId === auto.itemId,
    );
    expect(change?.payload.via).toBe("auto_approve");

    for (const kind of ["token", "device"] as const) {
      const item = await insertItem(h, { projectId, state: "review", level: "render" });
      const attempt = service.create(
        item.itemId,
        { versionId: item.versionId, decision: "approve" },
        { kind, id: randomUUID(), userId: h.userId },
      );
      await expect(attempt).rejects.toBeInstanceOf(HttpError);
      await expect(attempt).rejects.toMatchObject({ code: "invalid_transition" });
      const [row] = await h.db
        .select({ state: contentItems.state })
        .from(contentItems)
        .where(eq(contentItems.id, item.itemId));
      expect(row?.state).toBe("review");
    }
  });

  it("decides inside a caller's transaction and publishes after its commit", async () => {
    const service = reviewsServiceFor(h.deps);
    const inserted = await insertItem(h, { projectId, state: "review", level: "render" });
    let duringTx = 0;
    await transaction(h.db, async (tx) => {
      await service.create(
        inserted.itemId,
        { versionId: inserted.versionId, decision: "approve" },
        SYSTEM_ACTOR,
        { tx },
      );
      duringTx = eventsOf(h.live, "review.created").filter(
        (event) => event.payload.review.itemId === inserted.itemId,
      ).length;
    });
    expect(duringTx).toBe(0);
    expect(
      eventsOf(h.live, "review.created").filter(
        (event) => event.payload.review.itemId === inserted.itemId,
      ),
    ).toHaveLength(1);
  });
});

describe("review queue", () => {
  it("orders items in review by target time, unscheduled last, then by waiting time", async () => {
    const project = await insertProject(h);
    const add = (targetAt: Date | null, title: string) =>
      insertItem(h, { projectId: project, state: "review", level: "render", targetAt, title });
    const late = await add(new Date("2026-11-03T09:00:00Z"), "late");
    const unscheduledOld = await add(null, "unscheduled old");
    const soon = await add(new Date("2026-11-01T09:00:00Z"), "soon");
    const unscheduledNew = await add(null, "unscheduled new");
    const soonSecond = await add(new Date("2026-11-01T09:00:00Z"), "soon second");
    await insertItem(h, { projectId: project, state: "approved", level: "render" });
    // Fix the waiting order, which the inserts alone leave to the clock.
    const order = [late, unscheduledOld, soon, unscheduledNew, soonSecond];
    for (const [index, item] of order.entries()) {
      await h.db
        .update(contentItems)
        .set({ updatedAt: new Date(Date.UTC(2026, 9, 1, 0, index)) })
        .where(eq(contentItems.id, item.itemId));
    }

    const seen: ContentItem[] = [];
    let cursor: string | null = null;
    do {
      const query = `projectId=${project}&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
      const response = await call(h, "GET", `/api/reviews/queue?${query}`);
      expect(response.status).toBe(200);
      const page = ItemPage.parse(await response.json());
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen.map((item) => item.title)).toEqual([
      "soon",
      "soon second",
      "late",
      "unscheduled old",
      "unscheduled new",
    ]);

    expect((await call(h, "GET", `/api/reviews/queue?projectId=${randomUUID()}`)).status).toBe(404);
    expect((await call(h, "GET", "/api/reviews/queue?cursor=bm9wZQ")).status).toBe(400);
  });
});
