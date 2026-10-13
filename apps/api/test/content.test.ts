import { randomUUID } from "node:crypto";
import {
  type ContentItem,
  ContentItemDetailSchema,
  ContentItemSchema,
  ContentVersionSchema,
  ContentVersionSummarySchema,
  cursorPageSchema,
  EditVersionResponseSchema,
  FormatSchema,
  listSchema,
  SeriesSchema,
} from "@loomcast/contracts";
import { auditLog, contentItems, contentVersions } from "@loomcast/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectsService } from "../src/modules/projects";
import {
  call,
  createPipelineHarness,
  eventsOf,
  insertAsset,
  insertItem,
  insertProject,
  type PipelineHarness,
  script,
  storyboard,
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

async function createItem(body: Record<string, unknown>, project = projectId) {
  const response = await call(h, "POST", `/api/projects/${project}/content`, body);
  expect(response.status).toBe(201);
  return ContentItemDetailSchema.parse(await response.json());
}

async function edit(itemId: string, body: Record<string, unknown>) {
  return call(h, "POST", `/api/content/${itemId}/versions`, body);
}

async function editOk(itemId: string, body: Record<string, unknown>) {
  const response = await edit(itemId, body);
  expect(response.status, await response.clone().text()).toBe(201);
  return EditVersionResponseSchema.parse(await response.json());
}

async function newSeries(project = projectId) {
  const format = FormatSchema.parse(
    await (await call(h, "POST", `/api/projects/${project}/formats`, { name: "Fmt" })).json(),
  );
  const series = SeriesSchema.parse(
    await (
      await call(h, "POST", `/api/projects/${project}/series`, {
        name: "Series",
        formatId: format.id,
      })
    ).json(),
  );
  return { format, series };
}

describe("content items", () => {
  it("creates an idea with version 1 and publishes content.item.created", async () => {
    const { format, series } = await newSeries();
    const created = await createItem({
      title: "Borrow checker basics",
      pitch: "",
      topic: "rust",
      seriesId: series.id,
      targetAt: "2026-11-02T09:00:00.000Z",
    });
    expect(created.item).toMatchObject({
      state: "idea",
      versionNo: 1,
      pitch: null,
      topic: "rust",
      seriesId: series.id,
      targetAt: "2026-11-02T09:00:00.000Z",
      createdVia: "ui",
      createdBy: h.userId,
      durationMs: null,
      posterAssetId: null,
      autopilotTarget: null,
      lastError: null,
    });
    expect(created.currentVersion).toMatchObject({
      versionNo: 1,
      stage: "idea",
      script: null,
      storyboard: null,
      createdVia: "system",
      formatVersionId: format.currentVersion.id,
    });
    expect(created.versions).toHaveLength(1);
    expect(created.activeJob).toBeNull();
    const [event] = eventsOf(h.live, "content.item.created").filter(
      (entry) => entry.payload.item.id === created.item.id,
    );
    expect(event?.payload.item.currentVersionId).toBe(created.currentVersion.id);
  });

  it("refuses series of other projects, archived series and archived projects", async () => {
    const other = await newSeries(await insertProject(h));
    const foreign = await call(h, "POST", `/api/projects/${projectId}/content`, {
      title: "Foreign",
      seriesId: other.series.id,
    });
    expect(foreign.status).toBe(400);

    const { series } = await newSeries();
    await call(h, "POST", `/api/series/${series.id}/archive`);
    const closed = await call(h, "POST", `/api/projects/${projectId}/content`, {
      title: "Closed",
      seriesId: series.id,
    });
    expect(closed.status).toBe(409);

    const archived = await insertProject(h, "archived");
    const late = await call(h, "POST", `/api/projects/${archived}/content`, { title: "Late" });
    expect(late.status).toBe(409);
  });

  it("gets, renames and lists versions of an item", async () => {
    const created = await createItem({ title: "Original", pitch: "First pitch" });
    const id = created.item.id;
    const patched = await call(h, "PATCH", `/api/content/${id}`, { title: "Renamed", pitch: null });
    expect(patched.status).toBe(200);
    const item = ContentItemSchema.parse(await patched.json());
    expect(item).toMatchObject({ title: "Renamed", pitch: null, versionNo: 1, state: "idea" });

    const detail = ContentItemDetailSchema.parse(
      await (await call(h, "GET", `/api/content/${id}`)).json(),
    );
    expect(detail.item.title).toBe("Renamed");

    await editOk(id, { baseVersionId: detail.currentVersion.id, script: script() });
    const list = listSchema(ContentVersionSummarySchema).parse(
      await (await call(h, "GET", `/api/content/${id}/versions`)).json(),
    );
    expect(list.items.map((version) => [version.versionNo, version.hasScript])).toEqual([
      [2, true],
      [1, false],
    ]);
    const first = await call(h, "GET", `/api/content/${id}/versions/${detail.currentVersion.id}`);
    expect(ContentVersionSchema.parse(await first.json()).versionNo).toBe(1);

    const missing = randomUUID();
    expect((await call(h, "GET", `/api/content/${missing}`)).status).toBe(404);
    expect((await call(h, "GET", `/api/content/${id}/versions/${missing}`)).status).toBe(404);
    expect((await call(h, "GET", `/api/content/${missing}/versions`)).status).toBe(404);
    expect((await call(h, "PATCH", `/api/content/${missing}`, { title: "X" })).status).toBe(404);
  });

  it("counts live items in the project stats", async () => {
    const project = await insertProject(h);
    await createItem({ title: "One" }, project);
    await insertItem(h, { projectId: project, state: "archived" });
    const stats = await createProjectsService(h.deps).stats(project);
    expect(stats.items).toBe(1);
  });
});

describe("content list", () => {
  let project: string;
  let seriesId: string;
  const ids: string[] = [];

  beforeAll(async () => {
    project = await insertProject(h);
    ({
      series: { id: seriesId },
    } = await newSeries(project));
    for (let index = 0; index < 5; index += 1) {
      const created = await createItem(
        {
          title: index === 2 ? "Async 100% explained" : `Item ${index}`,
          seriesId: index < 2 ? seriesId : undefined,
          targetAt: `2026-11-0${index + 1}T09:00:00.000Z`,
        },
        project,
      );
      ids.push(created.item.id);
    }
    await call(h, "POST", `/api/content/${ids[4]}/archive`);
  });

  async function list(query: string) {
    const response = await call(h, "GET", `/api/content?projectId=${project}${query}`);
    expect(response.status).toBe(200);
    return ItemPage.parse(await response.json());
  }

  it("pages most recently updated first and leaves archived items out", async () => {
    const seen: ContentItem[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(`&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen.map((item) => item.id)).toEqual([ids[3], ids[2], ids[1], ids[0]]);
  });

  it("filters by states, series, text and target range", async () => {
    const archived = await list("&states=archived");
    expect(archived.items.map((item) => item.id)).toEqual([ids[4]]);
    const both = await list("&states=idea,archived");
    expect(both.items).toHaveLength(5);
    const repeated = await list("&states=idea&states=archived");
    expect(repeated.items).toHaveLength(5);

    const inSeries = await list(`&seriesId=${seriesId}`);
    expect(inSeries.items.map((item) => item.id).sort()).toEqual([ids[0], ids[1]].sort());

    // `%` is matched literally, not as a wildcard.
    const text = await list(`&q=${encodeURIComponent("100%")}`);
    expect(text.items.map((item) => item.id)).toEqual([ids[2]]);

    const range = await list(
      "&targetFrom=2026-11-02T00:00:00.000Z&targetTo=2026-11-03T23:00:00.000Z",
    );
    expect(range.items.map((item) => item.id).sort()).toEqual([ids[1], ids[2]].sort());
  });

  it("rejects bad cursors and unknown projects", async () => {
    const bad = await call(h, "GET", `/api/content?projectId=${project}&cursor=bm9wZQ`);
    expect(bad.status).toBe(400);
    expect((await call(h, "GET", `/api/content?projectId=${randomUUID()}`)).status).toBe(404);
    expect((await call(h, "GET", "/api/content?states=nope")).status).toBe(400);
  });
});

describe("version edits", () => {
  async function currentOf(itemId: string) {
    const [row] = await h.db
      .select()
      .from(contentVersions)
      .innerJoin(contentItems, eq(contentItems.currentVersionId, contentVersions.id))
      .where(eq(contentItems.id, itemId));
    if (row === undefined) throw new Error("no current version");
    return { version: row.content_versions, item: row.content_items };
  }

  it("walks an idea through script, storyboard and voice with user edits", async () => {
    const created = await createItem({ title: "Walk" });
    const id = created.item.id;
    const v2 = await editOk(id, { baseVersionId: created.currentVersion.id, script: script() });
    expect(v2.item.state).toBe("script");
    expect(v2.version).toMatchObject({ versionNo: 2, stage: "script", createdVia: "ui" });
    expect(v2.version.parentVersionId).toBe(created.currentVersion.id);

    const v3 = await editOk(id, { baseVersionId: v2.version.id, storyboard: storyboard() });
    expect(v3.item.state).toBe("storyboard");
    expect(v3.version.script).toEqual(script());

    const voice = await insertAsset(h.db, { projectId, itemId: id, kind: "voice" });
    const v4 = await editOk(id, { baseVersionId: v3.version.id, voiceAssetId: voice });
    expect(v4.item.state).toBe("voice");
    expect(v4.version.voiceAssetId).toBe(voice);

    const created4 = eventsOf(h.live, "content.version.created").filter(
      (event) => event.payload.version.itemId === id,
    );
    expect(created4.map((event) => event.payload.version.versionNo)).toEqual([2, 3, 4]);
    const audits = await h.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, id), eq(auditLog.action, "content.version.created")));
    expect(audits).toHaveLength(3);
  });

  it("clears voice, render, poster and storyboard when the script changes", async () => {
    const inserted = await insertItem(h, { projectId, state: "render", level: "render" });
    const result = await editOk(inserted.itemId, {
      baseVersionId: inserted.versionId,
      script: script({ hook: "A different opening line." }),
    });
    expect(result.item.state).toBe("script");
    expect(result.version).toMatchObject({
      stage: "script",
      voiceAssetId: null,
      renderAssetId: null,
      posterAssetId: null,
      storyboard: null,
      hasScript: true,
    });
    expect(result.item.durationMs).toBeNull();
    expect(result.item.posterAssetId).toBeNull();
  });

  it("keeps a storyboard sent together with a changed script", async () => {
    const inserted = await insertItem(h, { projectId, state: "render", level: "render" });
    const board = storyboard({ styleId: "bold-grid" });
    const result = await editOk(inserted.itemId, {
      baseVersionId: inserted.versionId,
      script: script({ hook: "New hook." }),
      storyboard: board,
    });
    expect(result.item.state).toBe("storyboard");
    expect(result.version.storyboard).toEqual(board);
    expect(result.version.voiceAssetId).toBeNull();
  });

  it("clears render and poster when the storyboard changes, keeping the voice", async () => {
    const inserted = await insertItem(h, { projectId, state: "render", level: "render" });
    const result = await editOk(inserted.itemId, {
      baseVersionId: inserted.versionId,
      storyboard: storyboard({ styleId: "minimal" }),
    });
    expect(result.item.state).toBe("voice");
    expect(result.version).toMatchObject({
      voiceAssetId: inserted.voiceAssetId,
      renderAssetId: null,
      posterAssetId: null,
    });
    expect(result.version.script).toEqual(script());
  });

  it("clears the render for a new voice take of the same item only", async () => {
    const inserted = await insertItem(h, { projectId, state: "render", level: "render" });
    const take = await insertAsset(h.db, { projectId, itemId: inserted.itemId, kind: "voice" });
    const result = await editOk(inserted.itemId, {
      baseVersionId: inserted.versionId,
      voiceAssetId: take,
    });
    expect(result.item.state).toBe("voice");
    expect(result.version).toMatchObject({
      voiceAssetId: take,
      renderAssetId: null,
      posterAssetId: null,
    });

    const other = await insertItem(h, { projectId, state: "idea" });
    const foreign = await insertAsset(h.db, { projectId, itemId: other.itemId, kind: "voice" });
    const pending = await insertAsset(h.db, {
      projectId,
      itemId: inserted.itemId,
      kind: "voice",
      status: "pending",
    });
    const wrongKind = await insertAsset(h.db, {
      projectId,
      itemId: inserted.itemId,
      kind: "render",
    });
    for (const voiceAssetId of [foreign, pending, wrongKind, randomUUID()]) {
      const response = await edit(inserted.itemId, {
        baseVersionId: result.version.id,
        voiceAssetId,
      });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("validation_failed");
    }
  });

  it("does not invalidate anything for an identical script", async () => {
    const inserted = await insertItem(h, { projectId, state: "render", level: "render" });
    const result = await editOk(inserted.itemId, {
      baseVersionId: inserted.versionId,
      script: script(),
      notes: "Same words",
    });
    expect(result.item.state).toBe("render");
    expect(result.version.renderAssetId).toBe(inserted.renderAssetId);
    expect(result.version.notes).toBe("Same words");
  });

  it("keeps an item in review or approved for a caption change", async () => {
    for (const state of ["review", "approved"] as const) {
      const inserted = await insertItem(h, { projectId, state, level: "render" });
      const result = await editOk(inserted.itemId, {
        baseVersionId: inserted.versionId,
        caption: "A sharper caption",
      });
      expect(result.item.state).toBe(state);
      expect(result.version).toMatchObject({ caption: "A sharper caption", stage: state });
      expect(result.version.renderAssetId).toBe(inserted.renderAssetId);
    }
  });

  it("sends an approved item back into production when its script changes", async () => {
    const inserted = await insertItem(h, { projectId, state: "approved", level: "render" });
    const result = await editOk(inserted.itemId, {
      baseVersionId: inserted.versionId,
      script: script({ cta: "Subscribe." }),
    });
    expect(result.item.state).toBe("script");
  });

  it("answers 409 for a stale base version and writes nothing", async () => {
    const created = await createItem({ title: "Stale" });
    const first = await editOk(created.item.id, {
      baseVersionId: created.currentVersion.id,
      script: script(),
    });
    const stale = await edit(created.item.id, {
      baseVersionId: created.currentVersion.id,
      script: script({ hook: "Lost update" }),
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      error: { code: string; details: { reason: string; currentVersionId: string } };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details).toEqual({
      reason: "stale_version",
      currentVersionId: first.version.id,
    });
    const { version } = await currentOf(created.item.id);
    expect(version.id).toBe(first.version.id);
    expect(version.versionNo).toBe(2);
  });

  it("refuses edits the state machine does not allow", async () => {
    for (const state of ["scheduled", "published", "archived"] as const) {
      const inserted = await insertItem(h, { projectId, state, level: "render" });
      const response = await edit(inserted.itemId, {
        baseVersionId: inserted.versionId,
        caption: "Too late",
      });
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe("invalid_transition");
    }
    // An idea needs a script before it gets a version of its own.
    const idea = await createItem({ title: "Bare" });
    const notes = await edit(idea.item.id, {
      baseVersionId: idea.currentVersion.id,
      notes: "Just a note",
    });
    expect(notes.status).toBe(409);
    expect((await edit(randomUUID(), { baseVersionId: randomUUID(), notes: "x" })).status).toBe(
      404,
    );
    const empty = await edit(idea.item.id, { baseVersionId: idea.currentVersion.id });
    expect(empty.status).toBe(400);
  });
});
