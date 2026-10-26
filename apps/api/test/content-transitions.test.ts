import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTOR_KINDS,
  type ActorKind,
  ContentItemSchema,
  canTransition,
  DEFAULT_FORMAT_RULES,
  type JobType,
  PIPELINE_STATES,
  PIPELINE_TRANSITIONS,
} from "@loomcast/contracts";
import { auditLog, contentItems, contentVersions, jobs } from "@loomcast/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transaction } from "../src/lib/db";
import { HttpError } from "../src/lib/errors";
import {
  type ContentService,
  contentServiceFor,
  type PipelineActor,
  SYSTEM_ACTOR,
} from "../src/modules/content";
import {
  call,
  createPipelineHarness,
  eventsOf,
  insertAsset,
  insertItem,
  insertItems,
  insertWorkspace,
  internalOf,
  type PipelineHarness,
  script,
  storyboard,
} from "./pipeline-support";
import { errorCode } from "./support";

/** Matrix cases in flight at once: the test database pool's size. */
const MATRIX_CONCURRENCY = 5;

let h: PipelineHarness;
let workspaceId: string;
let content: ContentService;

beforeAll(async () => {
  h = await createPipelineHarness();
  workspaceId = await insertWorkspace(h);
  content = contentServiceFor(h.deps);
});

afterAll(async () => {
  await h.close();
});

function actorOf(kind: ActorKind): PipelineActor {
  switch (kind) {
    case "user":
      return { kind, id: h.userId, userId: h.userId };
    case "token":
      return { kind, id: randomUUID(), userId: h.userId };
    case "device":
      return { kind, id: randomUUID(), userId: h.userId };
    default:
      return SYSTEM_ACTOR;
  }
}

/** The status and error code of a rejected promise, or "ok". */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof HttpError) return `${error.status} ${error.code}`;
    throw error;
  }
}

async function stateOf(itemId: string) {
  const [row] = await h.db
    .select({ state: contentItems.state, archivedAt: contentItems.archivedAt })
    .from(contentItems)
    .where(eq(contentItems.id, itemId));
  return row;
}

describe("transition()", () => {
  it("allows exactly the moves of PIPELINE_TRANSITIONS, for every actor kind", async () => {
    const cases = PIPELINE_STATES.flatMap((from) =>
      PIPELINE_STATES.flatMap((to) => ACTOR_KINDS.map((kind) => ({ from, to, kind }))),
    );
    expect(cases).toHaveLength(PIPELINE_STATES.length ** 2 * ACTOR_KINDS.length);
    // One item per case, in a single insert. Each has a rendered version, so moves that need a
    // render are judged on the actor alone.
    const items = await insertItems(
      h,
      cases.map(({ from }) => ({ workspaceId, state: from, level: "render" as const })),
    );
    // The cases touch distinct items, so they run side by side, as many at once as the pool holds.
    const results: string[] = [];
    for (let start = 0; start < cases.length; start += MATRIX_CONCURRENCY) {
      const batch = cases.slice(start, start + MATRIX_CONCURRENCY).map(({ to, kind }, offset) => {
        const itemId = items[start + offset]?.itemId ?? "";
        return outcome(
          transaction(h.db, (tx) => content.transition(tx, itemId, to, actorOf(kind))),
        );
      });
      results.push(...(await Promise.all(batch)));
    }
    const rows = await h.db
      .select({ id: contentItems.id, state: contentItems.state })
      .from(contentItems)
      .where(
        inArray(
          contentItems.id,
          items.map((item) => item.itemId),
        ),
      );
    const states = new Map(rows.map((row) => [row.id, row.state]));

    const mismatches: string[] = [];
    cases.forEach(({ from, to, kind }, index) => {
      const expected =
        from === to || canTransition(from, to, kind, { renderAssetId: "r", script: 1 })
          ? "ok"
          : "409 invalid_transition";
      const after = states.get(items[index]?.itemId ?? "");
      const landed = after === (expected === "ok" ? to : from);
      if (results[index] !== expected || !landed) {
        mismatches.push(`${from}->${to} by ${kind}: ${results[index]}, state ${after}`);
      }
    });
    expect(mismatches).toEqual([]);
    // Both outcomes occur, so the matrix exercises refusals as well as moves.
    expect(results).toContain("ok");
    expect(results).toContain("409 invalid_transition");
  });

  it("refuses moves that need a render when the version has none", async () => {
    const needsRender = PIPELINE_TRANSITIONS.filter(
      (row) => row.requiresRender && row.from !== row.to,
    );
    expect(needsRender.length).toBeGreaterThan(0);
    for (const row of needsRender) {
      const inserted = await insertItem(h, { workspaceId, state: row.from, level: "voice" });
      const kind = row.actors[0] ?? "user";
      const result = await outcome(
        transaction(h.db, (tx) =>
          content.transition(tx, inserted.itemId, row.to, actorOf(kind), { via: row.via }),
        ),
      );
      expect(result, `${row.from}->${row.to} via ${row.via}`).toBe("409 invalid_transition");
    }
  });

  it("tells moves apart by kind when `via` is given", async () => {
    const inserted = await insertItem(h, { workspaceId, state: "review", level: "render" });
    // The system may auto-approve but never take a user's approve decision.
    const asUser = await outcome(
      transaction(h.db, (tx) =>
        content.transition(tx, inserted.itemId, "approved", SYSTEM_ACTOR, { via: "approve" }),
      ),
    );
    expect(asUser).toBe("409 invalid_transition");
    const auto = await outcome(
      transaction(h.db, (tx) =>
        content.transition(tx, inserted.itemId, "approved", SYSTEM_ACTOR, { via: "auto_approve" }),
      ),
    );
    expect(auto).toBe("ok");
  });

  it("audits the move and publishes content.item.updated and state_changed after commit", async () => {
    const inserted = await insertItem(h, { workspaceId, state: "render", level: "render" });
    const token = actorOf("token");
    let publishedInside = -1;
    const item = await transaction(h.db, async (tx) => {
      const moved = await content.transition(tx, inserted.itemId, "review", token, {
        reason: "rendered",
      });
      publishedInside = internalOf(h.internal, "content.item.state_changed").filter(
        (event) => event.payload.itemId === inserted.itemId,
      ).length;
      return moved;
    });
    expect(publishedInside).toBe(0);
    expect(item.state).toBe("review");

    const [change] = internalOf(h.internal, "content.item.state_changed").filter(
      (event) => event.payload.itemId === inserted.itemId,
    );
    expect(change?.payload).toEqual({
      itemId: inserted.itemId,
      workspaceId,
      from: "render",
      to: "review",
      actor: { kind: "token", id: token.id },
      versionId: inserted.versionId,
      previousVersionId: inserted.versionId,
      via: "submit",
      reason: "rendered",
    });
    const [updated] = eventsOf(h.live, "content.item.updated").filter(
      (event) => event.payload.item.id === inserted.itemId,
    );
    expect(updated?.payload.item.state).toBe("review");
    // Internal events never reach the browser stream.
    expect(h.live.some((event) => (event.type as string) === "content.item.state_changed")).toBe(
      false,
    );

    const [entry] = await h.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetId, inserted.itemId),
          eq(auditLog.action, "content.item.transitioned"),
        ),
      );
    expect(entry).toMatchObject({ actorKind: "token", actorId: token.id });
    expect(entry?.data).toMatchObject({ from: "render", to: "review", via: "submit" });
  });

  it("publishes nothing when the transaction rolls back", async () => {
    const inserted = await insertItem(h, { workspaceId, state: "render", level: "render" });
    await expect(
      transaction(h.db, async (tx) => {
        await content.transition(tx, inserted.itemId, "review", actorOf("user"));
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect((await stateOf(inserted.itemId))?.state).toBe("render");
    expect(
      internalOf(h.internal, "content.item.state_changed").some(
        (event) => event.payload.itemId === inserted.itemId,
      ),
    ).toBe(false);
  });

  it("archives and restores through the REST routes", async () => {
    const inserted = await insertItem(h, { workspaceId, state: "voice", level: "voice" });
    const archived = ContentItemSchema.parse(
      await (await call(h, "POST", `/api/content/${inserted.itemId}/archive`)).json(),
    );
    expect(archived.state).toBe("archived");
    expect(archived.archivedAt).not.toBeNull();

    const restored = ContentItemSchema.parse(
      await (await call(h, "POST", `/api/content/${inserted.itemId}/restore`)).json(),
    );
    expect(restored).toMatchObject({ state: "idea", archivedAt: null });

    const scripted = await insertItem(h, { workspaceId, state: "script", level: "script" });
    const refused = await call(h, "POST", `/api/content/${scripted.itemId}/restore`);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("invalid_transition");
    expect((await call(h, "POST", `/api/content/${randomUUID()}/archive`)).status).toBe(404);
  });

  it("stops autopilot when an item is archived", async () => {
    const inserted = await insertItem(h, { workspaceId, state: "script", level: "script" });
    await transaction(h.db, (tx) =>
      content.track(tx, inserted.itemId, { autopilotTarget: "review" }),
    );
    const item = await content.archive(inserted.itemId, actorOf("user"));
    expect(item.autopilotTarget).toBeNull();
  });
});

describe("versions from every kind of actor", () => {
  it("lets a token write a script (an MCP submission) but never approve", async () => {
    const inserted = await insertItem(h, { workspaceId, state: "idea" });
    const token = actorOf("token");
    const result = await transaction(h.db, (tx) =>
      content.createVersion(tx, inserted.itemId, { script: script() }, token, {
        baseVersionId: inserted.versionId,
      }),
    );
    expect(result.item.state).toBe("script");
    expect(result.version).toMatchObject({ createdVia: "mcp", stage: "script" });

    const review = await insertItem(h, { workspaceId, state: "review", level: "render" });
    const approve = await outcome(
      transaction(h.db, (tx) => content.transition(tx, review.itemId, "approved", token)),
    );
    expect(approve).toBe("409 invalid_transition");
  });

  it("refuses a token's caption change in review, which only a user may make", async () => {
    const review = await insertItem(h, { workspaceId, state: "review", level: "render" });
    const result = await outcome(
      transaction(h.db, (tx) =>
        content.createVersion(tx, review.itemId, { caption: "x" }, actorOf("token")),
      ),
    );
    expect(result).toBe("409 invalid_transition");
  });

  it("lets the system write versions and move approved items to scheduled", async () => {
    const inserted = await insertItem(h, { workspaceId, state: "storyboard", level: "storyboard" });
    const voice = await insertAsset(h.db, { workspaceId, itemId: inserted.itemId, kind: "voice" });
    const result = await transaction(h.db, (tx) =>
      content.createVersion(tx, inserted.itemId, { voiceAssetId: voice }, SYSTEM_ACTOR),
    );
    expect(result.item.state).toBe("voice");
    expect(result.version.createdVia).toBe("system");

    const approved = await insertItem(h, { workspaceId, state: "approved", level: "render" });
    const scheduled = await transaction(h.db, (tx) =>
      content.transition(tx, approved.itemId, "scheduled", SYSTEM_ACTOR, { via: "schedule" }),
    );
    expect(scheduled.state).toBe("scheduled");
  });
});

describe("createVersionFromJob()", () => {
  async function insertJob(itemId: string, versionId: string, type: JobType = "content.render") {
    const [job] = await h.db
      .insert(jobs)
      .values({
        type,
        status: "running",
        workspaceId,
        createdBy: h.userId,
        payload: {
          workspaceId,
          itemId,
          versionId,
          format: { formatVersionId: null, rules: structuredClone(DEFAULT_FORMAT_RULES) },
        },
      })
      .returning();
    if (job === undefined) throw new Error("job was not inserted");
    return job;
  }

  it("stores a render result once, however often the completion is replayed", async () => {
    const inserted = await insertItem(h, { workspaceId, state: "voice", level: "voice" });
    const job = await insertJob(inserted.itemId, inserted.versionId);
    const render = await insertAsset(h.db, {
      workspaceId,
      itemId: inserted.itemId,
      kind: "render",
    });
    const poster = await insertAsset(h.db, {
      workspaceId,
      itemId: inserted.itemId,
      kind: "poster",
    });
    const store = () =>
      transaction(h.db, (tx) =>
        content.createVersionFromJob(
          tx,
          job.id,
          inserted.itemId,
          { renderAssetId: render, posterAssetId: poster },
          // A render result may go straight to review.
          { state: "review" },
        ),
      );

    const first = await store();
    expect(first.created).toBe(true);
    expect(first.item.state).toBe("review");
    expect(first.item.posterAssetId).toBe(poster);
    expect(first.version).toMatchObject({
      stage: "review",
      createdVia: "job",
      jobId: job.id,
      renderAssetId: render,
      voiceAssetId: inserted.voiceAssetId,
      createdByUser: h.userId,
    });

    const replays = await Promise.all(Array.from({ length: 10 }, store));
    for (const replay of replays) {
      expect(replay.created).toBe(false);
      expect(replay.version.id).toBe(first.version.id);
    }
    const versions = await h.db
      .select({ id: contentVersions.id })
      .from(contentVersions)
      .where(eq(contentVersions.jobId, job.id));
    expect(versions).toHaveLength(1);
    const changes = internalOf(h.internal, "content.item.state_changed").filter(
      (event) => event.payload.itemId === inserted.itemId,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload).toMatchObject({ from: "voice", to: "review", via: "submit" });
    expect(changes[0]?.payload.actor.kind).toBe("device");
  });

  it("refuses a result for another item and a stale base", async () => {
    const inserted = await insertItem(h, { workspaceId, state: "script", level: "script" });
    const other = await insertItem(h, { workspaceId, state: "script", level: "script" });
    const job = await insertJob(inserted.itemId, inserted.versionId, "content.storyboard");
    const wrongItem = await outcome(
      transaction(h.db, (tx) =>
        content.createVersionFromJob(tx, job.id, other.itemId, { storyboard: storyboard() }),
      ),
    );
    expect(wrongItem).toBe("400 validation_failed");

    // The user edits while the job runs; the job's base is now stale.
    await transaction(h.db, (tx) =>
      content.createVersion(
        tx,
        inserted.itemId,
        { script: script({ cta: "Edited" }) },
        {
          kind: "user",
          id: h.userId,
          userId: h.userId,
        },
      ),
    );
    const stale = await outcome(
      transaction(h.db, (tx) =>
        content.createVersionFromJob(
          tx,
          job.id,
          inserted.itemId,
          { storyboard: storyboard() },
          { baseVersionId: inserted.versionId },
        ),
      ),
    );
    expect(stale).toBe("409 conflict");
  });

  it("clears the last error on a successful step", async () => {
    const inserted = await insertItem(h, { workspaceId, state: "script", level: "script" });
    const job = await insertJob(inserted.itemId, inserted.versionId, "content.storyboard");
    await transaction(h.db, (tx) =>
      content.track(tx, inserted.itemId, {
        lastError: {
          jobId: job.id,
          jobType: "content.storyboard",
          code: "internal",
          message: "Something broke",
          at: new Date().toISOString(),
        },
      }),
    );
    const result = await transaction(h.db, (tx) =>
      content.createVersionFromJob(tx, job.id, inserted.itemId, { storyboard: storyboard() }),
    );
    expect(result.item.lastError).toBeNull();
    expect(result.item.state).toBe("storyboard");
    expect((await content.activeJob(inserted.itemId))?.id).toBe(job.id);
  });
});

describe("one writer of content_items.state", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const ALLOWED = "modules/content/transitions.ts";

  async function sourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries.map((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return Promise.resolve(entry.name.endsWith(".ts") ? [path] : []);
      }),
    );
    return files.flat();
  }

  it("has no raw state updates outside the transitions service", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(srcDir)) {
      const path = relative(srcDir, file);
      if (path === ALLOWED) continue;
      const text = await readFile(file, "utf8");
      // Query builder: `.update(contentItems)` followed by a `.set({...})` naming `state`.
      for (const match of text.matchAll(/\.update\(\s*contentItems\s*\)\s*\.set\(\s*\{/g)) {
        const body = setBody(text, (match.index ?? 0) + match[0].length - 1);
        if (/(^|[\s,{])state\s*:/.test(body) || /\.\.\./.test(body.replace(/\.\.\.\(/g, ""))) {
          offenders.push(`${path}: update(contentItems).set({ ${body.slice(1, 60)} … })`);
        }
      }
      // Raw SQL.
      if (/update\s+"?content_items"?[\s\S]{0,200}?\bset\b[\s\S]{0,200}?\bstate\b/i.test(text)) {
        offenders.push(`${path}: raw SQL update of content_items.state`);
      }
    }
    expect(offenders).toEqual([]);
    const allowed = await readFile(join(srcDir, ALLOWED), "utf8");
    expect(allowed).toMatch(/\.update\(contentItems\)/);
  });
});

/** The `{...}` object literal starting at `open`, with nested braces. */
function setBody(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  return text.slice(open);
}
